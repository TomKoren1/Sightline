/** The team: who is in this workspace, invites, and roles. Hosted mode only. */

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { z } from "zod";

import { isHosted } from "../config.js";
import type { AuthedRequest } from "./auth.guard.js";
import { HumanOnly, MinRole, TEAM_ROLES, type TeamRole } from "./roles.js";
import type { Session } from "./session.js";
import {
  acceptInvite,
  createInvite,
  listTeam,
  removeMember,
  revokeInvite,
  setRole,
  TeamRefused,
} from "./team.js";

const roleSchema = z.enum(TEAM_ROLES as [TeamRole, ...TeamRole[]]);
const idSchema = z.string().uuid();

function sessionOf(req: FastifyRequest): Session {
  if (!isHosted()) {
    throw new BadRequestException({
      error: "A self-hosted deployment has one operator and no sign-in, so there is no team.",
    });
  }
  const session = (req as unknown as AuthedRequest).session;
  if (!session) throw new BadRequestException({ error: "Not signed in" });
  return session;
}

async function refusable<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof TeamRefused) throw new BadRequestException({ error: err.message });
    throw err;
  }
}

const parse = <T>(schema: z.ZodType<T>, value: unknown, what: string): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException({ error: `Invalid ${what}.` });
  return result.data;
};

@HumanOnly()
@Controller("api/team")
export class TeamController {
  @Get()
  async team(@Req() req: FastifyRequest) {
    const session = sessionOf(req);
    return {
      you: { id: session.userId, role: session.role },
      ...(await listTeam(session.tenantId)),
    };
  }

  @MinRole("admin")
  @Post("invites")
  @HttpCode(201)
  invite(@Req() req: FastifyRequest, @Body() body: unknown) {
    const role = parse(roleSchema, (body as { role?: unknown } | null)?.role, "role");
    return refusable(() => createInvite(sessionOf(req), role));
  }

  @MinRole("admin")
  @Delete("invites/:id")
  async revoke(@Req() req: FastifyRequest, @Param("id") id: string) {
    if (!(await revokeInvite(sessionOf(req), parse(idSchema, id, "invite id")))) {
      throw new NotFoundException({ error: "No such open invite." });
    }
    return { revoked: true };
  }

  @MinRole("admin")
  @Patch("members/:id")
  async role(@Req() req: FastifyRequest, @Param("id") id: string, @Body() body: unknown) {
    const role = parse(roleSchema, (body as { role?: unknown } | null)?.role, "role");
    await refusable(() => setRole(sessionOf(req), parse(idSchema, id, "member id"), role));
    return { role };
  }

  @MinRole("admin")
  @Delete("members/:id")
  async remove(@Req() req: FastifyRequest, @Param("id") id: string) {
    await refusable(() => removeMember(sessionOf(req), parse(idSchema, id, "member id")));
    return { removed: true };
  }

  /** Any signed-in person may accept an invite; it is the link that grants. */
  @MinRole("viewer")
  @Post("join")
  @HttpCode(200)
  join(@Req() req: FastifyRequest, @Body() body: unknown) {
    const token = parse(
      z.string().min(20).max(200),
      (body as { token?: unknown } | null)?.token,
      "invite",
    );
    return refusable(() => acceptInvite(sessionOf(req), token));
  }
}
