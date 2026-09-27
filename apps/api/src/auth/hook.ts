/**
 * Attaching the signed-in tenant to every request.
 *
 * One `preHandler`, registered once, so a route cannot be added later that
 * forgets to authenticate - the failure mode of per-route middleware. Routes
 * do not opt in; they opt *out*, and the list of exemptions is short enough to
 * read in one glance below.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";

import { isHosted } from "../config.js";
import { SESSION_COOKIE, decodeSession, type Session } from "./session.js";
import type { TenantBearingRequest } from "../tenancy/request.js";
import { authFailures } from "../observability/metrics.js";

/** Routes that must work without a session, and why. */
const PUBLIC_PREFIXES = [
  "/auth/", // signing in cannot require being signed in
  "/api/me", // the UI asks this to decide whether to show a sign-in button
  "/api/health", // liveness, scraped by the cluster, reports no tenant data
  /**
   * Scraped by Prometheus, which has no session and cannot be given one.
   *
   * Safe to expose because of the label discipline in `metrics.ts`: no tenant
   * ids, no ARNs, no URLs, no secrets - only counts. In the cluster it is
   * reachable on the pod network; the tunnel exposes the web service, not
   * this.
   */
  "/metrics",
];

export function currentSession(req: FastifyRequest): Session | null {
  return (req as FastifyRequest & { session?: Session | null }).session ?? null;
}

export function registerAuth(app: FastifyInstance): void {
  app.addHook("preHandler", async (req, reply) => {
    // Self-hosted has one tenant and no sign-in; `tenantOf()` returns the
    // default and this hook has nothing to do.
    if (!isHosted()) return;

    const session = decodeSession(req.cookies[SESSION_COOKIE]);
    (req as FastifyRequest & { session?: Session | null }).session = session;
    if (session) {
      (req as FastifyRequest & TenantBearingRequest).tenant = session.tenantId;
    }

    if (PUBLIC_PREFIXES.some((prefix) => req.url.startsWith(prefix))) return;

    if (!session) {
      // Counted by reason: a spike in "expired" is a session length that is
      // too short for how people use this, while a spike in "absent" on a
      // route that used to work is usually a cookie that stopped being sent.
      authFailures.inc({ reason: req.cookies[SESSION_COOKIE] ? "invalid" : "absent" });
      return reply.code(401).send({ error: "Not signed in", signInUrl: "/auth/google" });
    }
  });
}
