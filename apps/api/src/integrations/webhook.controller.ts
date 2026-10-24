/** The workspace's webhook: admins set, test and remove it. The URL never comes back. */

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  Put,
  Req,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { z } from "zod";

import type { AuthedRequest } from "../core/request.js";
import { HumanOnly, MinRole } from "../core/access.js";
import { CurrentScope } from "../tenancy/currentScope.decorator.js";
import type { Scope } from "../core/scope.js";
import { deleteWebhook, getWebhook, sendTest, setWebhook, WebhookRefused } from "./notify.js";

const body = z.object({ url: z.string().trim().max(2048) });

@Controller("api/webhook")
export class WebhookController {
  @MinRole("admin")
  @Get()
  get(@CurrentScope() scope: Scope) {
    return getWebhook(scope.tenantId);
  }

  // A token can read and scan; it cannot redirect the workspace's alerts.
  @HumanOnly()
  @MinRole("admin")
  @Put()
  async set(@CurrentScope() scope: Scope, @Req() req: FastifyRequest, @Body() input: unknown) {
    const parsed = body.safeParse(input ?? {});
    if (!parsed.success) throw new BadRequestException({ error: "A webhook needs a url." });
    try {
      await setWebhook(
        scope.tenantId,
        parsed.data.url,
        (req as unknown as AuthedRequest).session?.userId ?? null,
      );
    } catch (err) {
      if (err instanceof WebhookRefused) throw new BadRequestException({ error: err.message });
      throw err;
    }
    return getWebhook(scope.tenantId);
  }

  @HumanOnly()
  @MinRole("admin")
  @Delete()
  @HttpCode(204)
  async remove(@CurrentScope() scope: Scope) {
    await deleteWebhook(scope.tenantId);
  }

  @MinRole("admin")
  @Post("test")
  @HttpCode(200)
  async test(@CurrentScope() scope: Scope) {
    const result = await sendTest(scope.tenantId);
    if (!result) throw new BadRequestException({ error: "No webhook is set." });
    return result;
  }
}
