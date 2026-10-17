/** A tenant's AWS accounts, and the connection scope every request runs on. */

import { Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";

import { ConnectionsController } from "./connections.controller.js";
import { TenantScopeInterceptor } from "./tenantScope.interceptor.js";

@Module({
  controllers: [ConnectionsController],
  /**
   * `APP_INTERCEPTOR` rather than `@UseInterceptors` per controller, for the
   * same reason the auth guard is `APP_GUARD`: one listed per controller is one
   * a new controller can omit. Here omitting it would mean the handler's
   * queries run outside a tenant context, which `db` refuses - so the failure
   * is loud, but it should not be reachable by forgetting in the first place.
   *
   * Runs *after* the guard, which is what resolves the tenant from the session
   * and puts it on the request. Nest's order is guards then interceptors, so
   * that dependency holds without being declared anywhere.
   */
  providers: [{ provide: APP_INTERCEPTOR, useClass: TenantScopeInterceptor }],
})
export class TenancyModule {}
