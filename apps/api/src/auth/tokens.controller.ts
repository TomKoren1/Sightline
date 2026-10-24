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

import { isHosted } from "../config.js";
import { createApiToken, listApiTokens, revokeApiToken, TokenRefused } from "./apiTokens.js";
import type { AuthedRequest } from "./auth.guard.js";
import { HumanOnly, MinRole } from "./roles.js";
import type { Session } from "./session.js";

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  role: z.enum(["viewer", "member", "admin"]),
  /** Null for a token that does not expire, which the UI does not offer by default. */
  expiresInDays: z.number().int().min(1).max(366).nullable().default(90),
});

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
