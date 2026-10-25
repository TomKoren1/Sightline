/**
 * `@CurrentTenant()` — for routes that are about the tenant rather than about
 * one of their AWS accounts.
 *
 * Separate from `@CurrentScope()` because the two fail differently: a tenant
 * who has connected no account has a tenant but no scope, and the routes they
 * need in order to connect one are exactly the routes that must still work.
 */

import { createParamDecorator, UnauthorizedException, type ExecutionContext } from "@nestjs/common";

import { isHosted } from "../../core/config.js";
import type { AuthedRequest } from "../../core/request.js";
import { LOCAL_TENANT_ID } from "../../tenancy/local.js";
import type { TenantId } from "../../core/ids.js";

export const CurrentTenant = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): TenantId => {
    if (!isHosted()) return LOCAL_TENANT_ID;
    const tenantId = ctx.switchToHttp().getRequest<AuthedRequest>().tenantId;
    if (!tenantId) throw new UnauthorizedException({ error: "Not signed in" });
    return tenantId;
  },
);

/** Whether this request may use admin-only facilities. */
export const IsAdmin = createParamDecorator((_data: unknown, ctx: ExecutionContext): boolean => {
  // A self-hosted clone is its own operator, so there is nobody to withhold
  // anything from.
  if (!isHosted()) return true;
  return ctx.switchToHttp().getRequest<AuthedRequest>().session?.isAdmin ?? false;
});
