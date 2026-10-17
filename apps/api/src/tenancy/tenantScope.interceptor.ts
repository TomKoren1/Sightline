/**
 * Every request's work runs on a connection scoped to its tenant.
 *
 * The one place the HTTP side opens a tenant context, so no route has to
 * remember. An interceptor rather than a guard because only an interceptor
 * *wraps* the handler, and the connection has to live as long as the response.
 *
 * It holds the connection until the handler completes because a streaming
 * response keeps querying after the handler returns - the scan progress stream
 * polls for as long as the scan runs - and an unscoped query sees nothing.
 *
 * Requests with no tenant yet (sign-in, the provider callback, health) pass
 * through; what they read runs on the `system` handle and is named there.
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
