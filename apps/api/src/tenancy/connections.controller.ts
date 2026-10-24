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
 * The external id is returned to whoever owns the connection, at creation and
 * from the onboarding plan afterwards. It was once-only to begin with, which is
 * the reflex and the wrong call: the value grants nothing without this
 * service's own credentials, their deployed stack holds it in plaintext in the
 * trust policy anyway, and hiding it made a failed deploy unrecoverable without
 * rotating a secret the stack already contained. It stays out of the connection
 * *list*, which renders on every page load.
 */

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
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
import { onboardingPlan, verifyConnection, VerifyTooSoon } from "./onboarding.js";
import { MinRole, RecentSignIn } from "../auth/roles.js";

const createSchema = z.object({
  kind: z.enum(["real", "demo", "organization"]).default("real"),
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

  @MinRole("admin")
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
       * The same string this service will present when assuming the role.
       *
       * Issued here rather than when a role ARN is saved, because the customer
       * needs it *before* a role exists. Generating a fresh one at save time
       * left the deployed stack and this service holding different secrets,
       * surfacing as AccessDenied with both ends looking correct.
       */
      externalId: created.externalId,
    };
  }

  /**
   * Everything needed to connect this account: the one-click link, and the two
   * alternatives for an estate that cannot use it.
   */
  @Get(":id/onboarding")
  async onboarding(@CurrentTenant() tenantId: TenantId, @Param("id") id: string) {
    const scope = { tenantId, connectionId: asConnectionId(id) };
    try {
      return await onboardingPlan(scope);
    } catch (err) {
      // A missing connection, a demo one, or a deployment with no published
      // template: all things the caller asked for wrongly, not failures.
      throw new BadRequestException({
        error: err instanceof Error ? err.message : "Could not build a connection plan",
      });
    }
  }

  /**
   * Try the connection, and pin the account if it works.
   *
   * Polled by the onboarding screen, so that it goes green while the customer
   * is still looking at CloudFormation rather than making them come back and
   * press something. A failure is a 200 with `ok: false` and a diagnosis: this
   * endpoint's job *is* the diagnosis, and a 5xx would make the UI render "the
   * request failed" over the top of an explanation of what to fix.
   */
  @MinRole("admin")
  @Post(":id/verify")
  @HttpCode(200)
  async verify(@CurrentTenant() tenantId: TenantId, @Param("id") id: string) {
    try {
      return await verifyConnection({ tenantId, connectionId: asConnectionId(id) });
    } catch (err) {
      if (err instanceof VerifyTooSoon) {
        throw new HttpException(
          { error: err.message, retryAfterMs: err.retryAfterMs },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      throw new BadRequestException({
        error: err instanceof Error ? err.message : "Could not verify the connection",
      });
    }
  }

  /**
   * Point a pending connection at an account.
   *
   * Twelve digits, and the role ARN is derived, because the role name is fixed
   * by the template we publish. One field rather than a pasted ARN is the whole
   * difference between an onboarding flow people finish and one they abandon.
   */
  @MinRole("admin")
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
  @RecentSignIn()
  @MinRole("admin")
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
