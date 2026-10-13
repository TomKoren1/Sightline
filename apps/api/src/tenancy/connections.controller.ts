/**
 * A tenant's AWS accounts: list, connect, disconnect.
 *
 * This is the part the earlier single-tenant version deliberately refused to
 * build. Its reasoning was sound at the time and is quoted in
 * `connection.service.ts`: with no authentication, a form that accepted a role
 * ARN and an external id would be an open endpoint that assumes a role into
 * somebody's account. The reason it is safe now is that there *is*
 * authentication, and every row is bound to the tenant that created it.
 *
 * The external id is returned **once**, at creation, because the customer needs
 * it to deploy the stack. It is never returned again.
 */

import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
} from "@nestjs/common";
import { z } from "zod";

import { cfg, isHosted } from "../config.js";
import {
  createConnection,
  deleteConnection,
  listConnections,
  setTargetAccount,
} from "./connections.js";
import { CurrentTenant, IsAdmin } from "./currentTenant.decorator.js";
import { asConnectionId, type TenantId } from "./ids.js";

const createSchema = z.object({
  kind: z.enum(["real", "demo"]).default("real"),
  label: z.string().trim().min(1).max(60),
});

const targetSchema = z.object({
  /** Twelve digits. The role ARN is derived, so this is the only field. */
  accountId: z.string().regex(/^\d{12}$/, "An AWS account id is twelve digits"),
  templateVersion: z.string().max(40).optional(),
});

@Controller("api/connections")
export class ConnectionsController {
  @Get()
  async list(@CurrentTenant() tenantId: TenantId) {
    return { connections: await listConnections(tenantId) };
  }

  @Post()
  @HttpCode(201)
  async create(
    @CurrentTenant() tenantId: TenantId,
    @IsAdmin() isAdmin: boolean,
    @Body() body: unknown,
  ) {
    const input = createSchema.parse(body ?? {});

    if (input.kind === "demo") {
      /**
       * The demo fixture is an operator's testing facility, not a product
       * feature, so it is gated twice: on the tenant's admin flag, and on
       * `DEMO_AWS_ENDPOINT_URL` being configured at all. Either gate alone
       * would do; two means neither a stray flag nor a stray environment
       * variable is sufficient by itself.
       */
      if (!isAdmin) {
        throw new ForbiddenException({
          error: "The demo account is not available on this plan.",
        });
      }
      if (isHosted() && !cfg.DEMO_AWS_ENDPOINT_URL) {
        throw new ForbiddenException({
          error: "This deployment has no demo fixture configured.",
        });
      }
    }

    const created = await createConnection(tenantId, input);
    return {
      id: created.id,
      /**
       * Shown once. The customer pastes it into CloudFormation, and it is the
       * same string this service will present when assuming the role - which is
       * the bug that generating a fresh one at save time caused: a stack and a
       * service holding different secrets, surfacing as AccessDenied with both
       * ends looking correct.
       */
      externalId: created.externalId,
      note: "Save this ExternalId now — it is shown only once.",
    };
  }

  /**
   * Point a pending connection at an account.
   *
   * Twelve digits, and the role ARN is derived, because the role name is fixed
   * by the template we publish. One field rather than a pasted ARN is the whole
   * difference between an onboarding flow people finish and one they abandon.
   */
  @Post(":id/target")
  @HttpCode(200)
  async target(
    @CurrentTenant() tenantId: TenantId,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const input = targetSchema.parse(body ?? {});
    const scope = { tenantId, connectionId: asConnectionId(id) };
    await setTargetAccount(scope, input);
    return { ok: true };
  }

  /**
   * Forget a connection.
   *
   * Deliberately does **not** claim the customer is disconnected: only they can
   * delete the CloudFormation stack that trusts us, and saying otherwise would
   * leave standing access nobody believed was there.
   */
  @Delete(":id")
  @HttpCode(200)
  async disconnect(@CurrentTenant() tenantId: TenantId, @Param("id") id: string) {
    await deleteConnection({ tenantId, connectionId: asConnectionId(id) });
    return {
      ok: true,
      note:
        "Sightline has forgotten this account. It cannot delete the CloudFormation stack in " +
        "your account — do that yourself to withdraw the access you granted.",
    };
  }
}
