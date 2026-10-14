/**
 * Every request's work runs on a connection scoped to its tenant.
 *
 * The one place the HTTP side opens a tenant context, so that no route has to
 * remember. An interceptor rather than a guard because only an interceptor
 * *wraps* the handler: guards run before it and cannot hold anything open
 * around it, and the connection has to live as long as the response does.
 *
 * ## Why it holds the connection to the end
 *
 * `withTenant` sets `app.tenant_id` on one connection at session level, and the
 * row-level security policies compare every row against it. A streaming
 * response keeps querying after the handler has started writing - the scan
 * progress stream polls Postgres once per tick for as long as the scan runs -
 * so releasing the connection when `intercept` returns would leave those
 * queries unscoped, and an unscoped query sees nothing. Awaiting the handler's
 * completion is what makes the stream work at all.
 *
 * ## Requests with no tenant
 *
 * Sign-in, the provider callback, health: there is no tenant yet, and the
 * things they read - a session by token hash, a user by provider subject - are
 * how the tenant gets discovered in the first place. Those run on the `system`
 * handle and are named individually there. Here they simply pass through.
 */

import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { defaultIfEmpty, firstValueFrom, from, type Observable } from "rxjs";

import { withTenant } from "../db/postgres.js";
import type { AuthedRequest } from "../auth/auth.guard.js";

@Injectable()
export class TenantScopeInterceptor implements NestInterceptor {
  /**
   * Not `async`, deliberately: it awaits nothing.
   *
   * `withTenant` is started here and the promise handed back as an Observable -
   * awaiting it would hold this method open for the whole response, including
   * every streaming one, and Nest would have nothing to return until the stream
   * ended.
   */
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const tenantId = req.tenantId ?? req.session?.tenantId ?? null;

    if (!tenantId) return next.handle();

    /**
     * `defaultIfEmpty` is not optional.
     *
     * A handler that takes `@Res()` and writes to the raw socket - every SSE
     * endpoint here - completes without emitting a value, and `firstValueFrom`
     * on an empty Observable rejects with `EmptyError`. Without this, every
     * streaming route would have started failing the moment this was added,
     * and the error would have pointed at rxjs rather than at here.
     */
    const completed = withTenant(tenantId, () =>
      firstValueFrom(next.handle().pipe(defaultIfEmpty(undefined))),
    );

    return from(completed);
  }
}
