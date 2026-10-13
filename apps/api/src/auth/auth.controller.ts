/**
 * Sign-in, sign-out, and who am I.
 *
 * The whole flow is three redirects and one cookie. Routes here are `@Public()`
 * because signing in cannot require being signed in, and because signing *out*
 * must keep working after a session has expired — otherwise a stale cookie
 * leaves someone stuck.
 *
 * Route order matters: Fastify matches in declaration order, so `providers`,
 * `logout` and `sessions` are declared before `:provider` or they would be
 * routed into it as provider names.
 */

import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";

import { cfg, isHosted } from "../config.js";
import { listConnections } from "../tenancy/connections.js";
import { Public } from "./public.decorator.js";
import { configuredProviders, createState, verifyState, type ProviderName } from "./oauth.js";
import { authorizationUrl, exchangeCode } from "./providers.js";
import {
  cookieOptions,
  issueSession,
  listSessions,
  revokeAllSessions,
  revokeSession,
  revokeSessionById,
  SESSION_COOKIE,
} from "./session.js";
import { findOrCreateUser, getUser, linkedProviders, SignInRefused } from "./users.js";
import type { AuthedRequest } from "./auth.guard.js";

/** Where to send the browser once sign-in has resolved, one way or the other. */
function appUrl(query: Record<string, string> = {}): string {
  const base = cfg.PUBLIC_BASE_URL.replace(/\/$/, "") || "/";
  const search = new URLSearchParams(query).toString();
  return search ? `${base}/?${search}` : `${base}/`;
}

function asProvider(value: string): ProviderName {
  if (value !== "google" && value !== "github") {
    throw new BadRequestException({ error: "Unknown sign-in provider" });
  }
  return value;
}

@Controller("api/auth")
export class AuthController {
  @Public()
  @Get("providers")
  providers() {
    return { providers: configuredProviders(), hosted: isHosted() };
  }

  /** Revoke this session. Public, so an expired cookie can still be cleared. */
  @Public()
  @Post("logout")
  @HttpCode(204)
  async logout(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    await revokeSession(req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
  }

  @Get("sessions")
  async sessions(@Req() req: FastifyRequest) {
    const session = (req as unknown as AuthedRequest).session;
    if (!session) throw new UnauthorizedException({ error: "Not signed in" });
    return {
      sessions: await listSessions(session.userId, req.cookies[SESSION_COOKIE]),
    };
  }

  /** Sign out everywhere. The one control that makes a stolen cookie survivable. */
  @Post("sessions/revoke-all")
  @HttpCode(200)
  async revokeAll(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const session = (req as unknown as AuthedRequest).session;
    if (!session) throw new UnauthorizedException({ error: "Not signed in" });
    const revoked = await revokeAllSessions(session.userId);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { revoked };
  }

  @Delete("sessions/:id")
  @HttpCode(204)
  async revokeOne(@Req() req: FastifyRequest, @Param("id") id: string) {
    const session = (req as unknown as AuthedRequest).session;
    if (!session) throw new UnauthorizedException({ error: "Not signed in" });
    await revokeSessionById(session.userId, id);
  }

  @Public()
  @Get(":provider")
  begin(@Param("provider") provider: string, @Res() reply: FastifyReply) {
    const name = asProvider(provider);
    if (!configuredProviders().includes(name)) {
      throw new BadRequestException({ error: `${name} sign-in is not configured` });
    }
    return reply.redirect(authorizationUrl(name, createState(name)), 302);
  }

  /**
   * The provider redirects here with a code.
   *
   * Failures redirect back to the app with a message rather than rendering an
   * error page: the person is mid-sign-in in a browser tab, and a JSON body is
   * not an answer. The provider's own diagnostic detail stays in the log.
   */
  @Public()
  @Get(":provider/callback")
  async callback(
    @Param("provider") provider: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const name = asProvider(provider);
    const query = req.query as { code?: string; state?: string; error?: string };

    if (query.error) {
      // The user declined at the provider, which is not an error here.
      return reply.redirect(appUrl({ signin: "cancelled" }), 302);
    }
    if (!verifyState(query.state, name)) {
      return reply.redirect(appUrl({ signin: "expired" }), 302);
    }
    if (!query.code) {
      return reply.redirect(appUrl({ signin: "failed" }), 302);
    }

    try {
      const identity = await exchangeCode(name, query.code);
      const user = await findOrCreateUser(identity);
      const token = await issueSession(user.id, {
        userAgent: req.headers["user-agent"],
        ip: req.ip,
      });
      reply.setCookie(SESSION_COOKIE, token, cookieOptions());
      return reply.redirect(appUrl(), 302);
    } catch (err) {
      req.log.error({ err }, "sign-in failed");
      // A refusal is something the person can act on, so it is passed through.
      // Anything else is ours, and says only that it failed.
      const message = err instanceof SignInRefused ? err.message : "failed";
      return reply.redirect(appUrl({ signin: message }), 302);
    }
  }
}

/**
 * `/api/me` — everything the UI needs to render its first frame.
 *
 * Public, because its whole job is to answer "is anyone signed in?" and it must
 * be able to say no. It returns the connection list too, so the frontend makes
 * one request before rendering rather than three.
 */
@Controller("api")
export class MeController {
  @Public()
  @Get("me")
  async me(@Req() req: FastifyRequest) {
    const session = (req as unknown as AuthedRequest).session;

    if (!isHosted()) {
      /**
       * A self-hosted clone has no sign-in. It still answers here, with the
       * same shape, so the frontend has one code path instead of two.
       */
      const scope = (req as unknown as AuthedRequest).scopeOutcome;
      const tenantId = scope?.ok ? scope.scope.tenantId : null;
      return {
        hosted: false,
        signedIn: true,
        user: null,
        isAdmin: true,
        providers: [],
        linked: [],
        connections: tenantId ? await listConnections(tenantId) : [],
      };
    }

    if (!session) {
      return {
        hosted: true,
        signedIn: false,
        user: null,
        isAdmin: false,
        providers: configuredProviders(),
        linked: [],
        connections: [],
      };
    }

    const [user, linked, connections] = await Promise.all([
      getUser(session.userId),
      linkedProviders(session.userId),
      listConnections(session.tenantId),
    ]);

    return {
      hosted: true,
      signedIn: true,
      user: user
        ? { email: user.email, name: user.name, avatarUrl: user.avatarUrl }
        : { email: session.email, name: null, avatarUrl: null },
      isAdmin: session.isAdmin,
      providers: configuredProviders(),
      linked,
      connections,
    };
  }
}
