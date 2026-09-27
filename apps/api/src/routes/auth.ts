/**
 * Sign in, sign out, and who am I.
 *
 * Registered in every mode, because a self-hosted deployment benefits from
 * `/api/me` reporting honestly that it is single-tenant, and because a route
 * that exists only in one mode is a route only tested in one mode. The sign-in
 * routes refuse rather than disappear when Google is not configured.
 */

import type { FastifyInstance } from "fastify";

import { cfg, isHosted } from "../config.js";
import {
  authorizationUrl,
  createState,
  exchangeCode,
  googleConfigProblem,
  verifyState,
} from "../auth/google.js";
import { findOrCreateGoogleUser } from "../auth/users.js";
import { SESSION_COOKIE, cookieOptions, newSession } from "../auth/session.js";
import { currentSession } from "../auth/hook.js";
import { defaultTenantId } from "../tenancy/tenant.js";
import { authFailures } from "../observability/metrics.js";

export function registerAuthRoutes(app: FastifyInstance): void {
  /**
   * Who is signed in.
   *
   * Never 401s: "nobody" is a legitimate answer and the UI needs it to decide
   * whether to show a sign-in button. Reserving 401 for endpoints that
   * genuinely could not be served keeps it meaningful.
   */
  app.get("/api/me", async (req) => {
    if (!isHosted()) {
      return {
        mode: "self-hosted" as const,
        user: null,
        tenantId: defaultTenantId(),
        note: "Self-hosted: this deployment is a single tenant and needs no sign-in.",
      };
    }
    const session = currentSession(req);
    return {
      mode: "hosted" as const,
      user: session ? { id: session.userId } : null,
      tenantId: session ? session.tenantId : null,
      signInUrl: "/auth/google",
    };
  });

  app.get("/auth/google", async (_req, reply) => {
    const problem = googleConfigProblem();
    if (problem) {
      // A misconfigured provider is an operator problem, and saying which
      // variable is missing turns it into a one-line fix. It names the
      // variable, never its value.
      return reply.code(503).send({ error: `Sign-in is not configured: ${problem}` });
    }
    return reply.redirect(authorizationUrl(createState()));
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    "/auth/google/callback",
    async (req, reply) => {
      const problem = googleConfigProblem();
      if (problem) return reply.code(503).send({ error: `Sign-in is not configured: ${problem}` });

      // The user declined at Google's consent screen. Not an error worth a
      // stack trace - send them back where they started.
      if (req.query.error) return reply.redirect("/?signin=cancelled");

      if (!verifyState(req.query.state)) {
        // Either a forged callback or one that sat in a tab for ten minutes.
        // Both mean "start again", and neither should say which.
        authFailures.inc({ reason: "bad_state" });
        return reply.code(400).send({ error: "Invalid or expired sign-in attempt. Try again." });
      }

      const code = req.query.code;
      if (!code) return reply.code(400).send({ error: "No authorization code" });

      try {
        const identity = await exchangeCode(code);
        const user = await findOrCreateGoogleUser({
          subject: identity.subject,
          email: identity.email,
        });
        reply.setCookie(SESSION_COOKIE, newSession(user.id, user.tenantId), cookieOptions());
        return reply.redirect("/");
      } catch (err) {
        // Google's own message names the cause (redirect_uri_mismatch,
        // invalid_client) and is the difference between ten minutes and an
        // afternoon - so it is logged, and not returned.
        req.log.error({ err }, "google sign-in failed");
        authFailures.inc({ reason: "google_exchange" });
        return reply.code(502).send({ error: "Sign-in failed. Please try again." });
      }
    },
  );

  app.post("/auth/logout", async (_req, reply) => {
    // maxAge 0 with the same attributes: a cookie is only cleared by a cookie
    // whose path and flags match the one that set it.
    reply.setCookie(SESSION_COOKIE, "", { ...cookieOptions(), maxAge: 0 });
    return reply.send({ ok: true });
  });

  /** Nothing here should ever be cached by a proxy. */
  app.addHook("onSend", async (req, reply, payload) => {
    if (req.url.startsWith("/auth/") || req.url === "/api/me") {
      reply.header("Cache-Control", "no-store");
    }
    return payload;
  });

  void cfg;
}
