/**
 * Every change anyone makes, recorded without each route having to remember:
 * a successful POST, PUT, PATCH or DELETE by a tenant becomes an entry with the
 * route, its parameters, the status, who and from where. Never the body - it
 * can hold a role ARN or a question - and never a GET. Refusals end in the
 * guard, before this runs. Team routes write their own, more specific entries.
 * A failed write is logged, not thrown: the change has already happened.
 */

import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { defaultIfEmpty, from, mergeMap, type Observable } from "rxjs";

import type { AuthedRequest } from "../core/request.js";
import { clientIp, recordAudit } from "./audit.js";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SELF_AUDITED = ["/api/team"];

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<FastifyRequest & AuthedRequest>();
    const route = req.routeOptions?.url ?? req.url;
    const tenantId = req.tenantId ?? req.session?.tenantId ?? null;
    if (
      !MUTATING.has(req.method) ||
      !tenantId ||
      SELF_AUDITED.some((prefix) => route.startsWith(prefix))
    ) {
      return next.handle();
    }

    const record = async () => {
      const params = (req.params ?? {}) as Record<string, string>;
      try {
        await recordAudit({
          tenantId,
          actorUserId: req.session?.userId ?? null,
          action: `${req.method} ${route}`,
          subject: Object.values(params)[0] ?? null,
          detail: { params, status: http.getResponse<FastifyReply>().statusCode },
          ip: clientIp(req),
        });
      } catch (err) {
        req.log.error({ err, route }, "audit entry not recorded");
      }
    };
    // A handler that writes to the socket itself completes without a value.
    return next.handle().pipe(
      defaultIfEmpty(undefined),
      mergeMap((value: unknown) => from(record().then(() => value))),
    );
  }
}
