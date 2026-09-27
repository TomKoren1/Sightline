/**
 * Rate limits and security headers, for a deployment reachable from the
 * internet.
 *
 * Limits apply in hosted mode only. A self-hosted operator running this
 * against their own account on localhost gains nothing from being
 * rate-limited, and a limit that fires during a demo is worse than no limit.
 *
 * They are **per tenant**, not per IP. Every request that matters here is
 * authenticated, tenants share NAT and corporate egress, and an IP is both too
 * coarse - one office, one bucket - and too easy to change. Unauthenticated
 * requests fall back to the IP, because there is nothing else to key on.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import helmet from "@fastify/helmet";

import { isHosted } from "../config.js";
import { currentSession } from "../auth/hook.js";

/** Tenant when we have one, IP when we do not. */
function keyFor(req: FastifyRequest): string {
  const session = currentSession(req);
  return session ? `tenant:${session.tenantId}` : `ip:${req.ip}`;
}

export async function registerSecurity(app: FastifyInstance): Promise<void> {
  /**
   * Headers.
   *
   * The API serves JSON, so most of CSP is irrelevant to it - but these cost
   * nothing and the same origin serves the frontend in production, behind one
   * tunnel. `frameAncestors: none` is the one that matters for a product
   * showing somebody's cloud inventory: it must not be embeddable.
   */
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // The UI is a Vite bundle with inline styles; scripts are not inline.
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
      },
    },
    // Cloudflare terminates TLS in front of this, so HSTS is theirs to set as
    // well - but a second declaration is harmless and survives the tunnel
    // being replaced by something that does not.
    hsts: { maxAge: 31_536_000, includeSubDomains: true },
    crossOriginEmbedderPolicy: false,
  });

  if (!isHosted()) return;

  /**
   * A generous global ceiling.
   *
   * Not a security control - it is the backstop that stops one runaway client
   * occupying the process, while the specific limits below do the real work.
   */
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
    keyGenerator: keyFor,
    // /metrics is scraped every 15-30s by Prometheus and health by the
    // kubelet; rate-limiting either would make the monitoring the incident.
    allowList: (req) => req.url === "/metrics" || req.url.startsWith("/api/health"),
    addHeaders: { "retry-after": true },
  });
}

/**
 * Per-route limits, applied where a request costs real money or real time.
 *
 * Separate numbers rather than more global rules, because the interesting
 * figure differs: a scan is minutes of AWS calls and a queue slot, an agent
 * answer is tokens on the tenant's own bill, and a connection test is an
 * AssumeRole that shows up in somebody else's CloudTrail.
 */
export const limits = {
  scan: { max: 6, timeWindow: "1 hour" },
  chat: { max: 60, timeWindow: "1 hour" },
  connectionTest: { max: 20, timeWindow: "10 minutes" },
  connectionWrite: { max: 30, timeWindow: "10 minutes" },
} as const;

/** Fastify route config for one of the limits above, in hosted mode only. */
export function limitConfig(limit: { max: number; timeWindow: string }): Record<string, unknown> {
  if (!isHosted()) return {};
  return { config: { rateLimit: { ...limit, keyGenerator: keyFor } } };
}
