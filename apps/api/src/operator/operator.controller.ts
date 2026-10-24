/** The operator's view across tenants. Signed in, operator tenant, admin or above. */

import { Controller, ForbiddenException, Get, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";

import { clientIp, recordAudit } from "../audit/audit.js";
import type { AuthedRequest } from "../auth/auth.guard.js";
import { HumanOnly, MinRole } from "../auth/roles.js";
import { IsAdmin } from "../tenancy/currentTenant.decorator.js";
import { tenantHealth } from "./operator.js";

@HumanOnly()
@Controller("api/operator")
export class OperatorController {
  @MinRole("admin")
  @Get("tenants")
  async tenants(@IsAdmin() isOperator: boolean, @Req() req: FastifyRequest) {
    if (!isOperator) {
      throw new ForbiddenException({ error: "This is the operator's view, across tenants." });
    }
    const session = (req as unknown as AuthedRequest).session;
    // A read, which the interceptor does not record; reading across tenants is.
    if (session) {
      await recordAudit({
        tenantId: session.tenantId,
        actorUserId: session.userId,
        action: "operator.viewed_tenants",
        ip: clientIp(req),
      });
    }
    return { tenants: await tenantHealth() };
  }
}
