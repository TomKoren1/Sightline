/** API tokens: create one (shown once), list them, revoke one. Admins, signed in. */

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Req,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { z } from "zod";

import { isHosted } from "../core/config.js";
import { createApiToken, listApiTokens, revokeApiToken, TokenRefused } from "./apiTokens.js";
import type { AuthedRequest } from "../core/request.js";
import { HumanOnly, MinRole } from "../core/access.js";
import type { Session } from "../core/request.js";
import { tokenCreateRequest as createSchema } from "@sightline/shared/api";

function sessionOf(req: FastifyRequest): Session {
  if (!isHosted()) {
    throw new BadRequestException({
      error:
        "A self-hosted deployment has no sign-in, so there is nothing for a token to stand for.",
    });
  }
  const session = (req as unknown as AuthedRequest).session;
  if (!session) throw new BadRequestException({ error: "Not signed in" });
  return session;
}

@HumanOnly()
@Controller("api/tokens")
export class TokensController {
  @MinRole("admin")
  @Get()
  async list(@Req() req: FastifyRequest) {
    return { tokens: await listApiTokens(sessionOf(req).tenantId) };
  }

  @MinRole("admin")
  @Post()
  @HttpCode(201)
  async create(@Req() req: FastifyRequest, @Body() body: unknown) {
    const parsed = createSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        error: "A token needs a name, a role of viewer, member or admin, and expiresInDays.",
      });
    }
    try {
      return await createApiToken(sessionOf(req), parsed.data);
    } catch (err) {
      if (err instanceof TokenRefused) throw new BadRequestException({ error: err.message });
      throw err;
    }
  }

  @MinRole("admin")
  @Delete(":id")
  @HttpCode(204)
  async revoke(@Req() req: FastifyRequest, @Param("id") id: string) {
    if (!z.string().uuid().safeParse(id).success) {
      throw new BadRequestException({ error: "Invalid token id." });
    }
    if (!(await revokeApiToken(sessionOf(req).tenantId, id))) {
      throw new NotFoundException({ error: "No such token in this workspace." });
    }
  }
}
