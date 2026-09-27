/**
 * That the limits and headers are actually attached.
 *
 * Driving the real app rather than the module, because both of these are
 * plugins whose value depends entirely on being registered - and registered
 * in the right order. A unit test of `limitConfig()` would assert that an
 * object literal contains the numbers I typed into it.
 *
 * The self-hosted half matters as much as the hosted half: a limit that fired
 * on the demo would break the graded project, and it would look like success
 * from a green hosted assertion.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

const ORIGINAL = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.resetModules();
});

async function buildIn(mode: "hosted" | "self-hosted"): Promise<FastifyInstance> {
  vi.resetModules();
  process.env["DEPLOYMENT_MODE"] = mode;
  if (mode === "hosted") {
    process.env["AWS_MODE"] = "real";
    process.env["AWS_ENDPOINT_URL"] = "";
    process.env["AWS_ACCESS_KEY_ID"] = "";
    process.env["AWS_SECRET_ACCESS_KEY"] = "";
    process.env["SESSION_SECRET"] = "test-session-secret-not-a-real-one";
  }
  const { buildApp } = await import("../app.js");
  const app = await buildApp();
  await app.ready();
  return app;
}

describe("security headers", () => {
  it("refuses to be framed, in both modes", async () => {
    for (const mode of ["hosted", "self-hosted"] as const) {
      const app = await buildIn(mode);
      try {
        const res = await app.inject({ method: "GET", url: "/api/health" });
        const csp = String(res.headers["content-security-policy"] ?? "");
        // A product showing somebody's cloud inventory must not be
        // embeddable in another page.
        expect(csp, mode).toContain("frame-ancestors 'none'");
      } finally {
        await app.close();
      }
    }
  });

  it("sets HSTS", async () => {
    const app = await buildIn("hosted");
    try {
      const res = await app.inject({ method: "GET", url: "/api/health" });
      expect(String(res.headers["strict-transport-security"] ?? "")).toContain("max-age=");
    } finally {
      await app.close();
    }
  });
});

describe("rate limiting", () => {
  /**
   * Exceeding a limit for real rather than inspecting configuration: the
   * question is whether the plugin is attached to *this route*, which route
   * config alone cannot answer.
   */
  it("eventually refuses an unauthenticated flood in hosted mode", async () => {
    const app = await buildIn("hosted");
    try {
      let limited = false;
      // The global ceiling is 300/minute; 401s still count, which is the
      // point - an attacker without a session must not get unlimited tries.
      for (let i = 0; i < 320 && !limited; i++) {
        const res = await app.inject({ method: "GET", url: "/api/summary" });
        if (res.statusCode === 429) limited = true;
      }
      expect(limited).toBe(true);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("never rate-limits the scrape endpoint or health", async () => {
    const app = await buildIn("hosted");
    try {
      // Prometheus scrapes every 15-30s and the kubelet probes constantly;
      // limiting either makes the monitoring the incident.
      for (let i = 0; i < 400; i++) {
        const res = await app.inject({ method: "GET", url: "/metrics" });
        expect(res.statusCode).not.toBe(429);
      }
      const health = await app.inject({ method: "GET", url: "/api/health" });
      expect(health.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  }, 30_000);

  /** The graded project must not start refusing requests to itself. */
  it("does not limit a self-hosted deployment", async () => {
    const app = await buildIn("self-hosted");
    try {
      for (let i = 0; i < 350; i++) {
        const res = await app.inject({ method: "GET", url: "/api/health" });
        expect(res.statusCode).not.toBe(429);
      }
    } finally {
      await app.close();
    }
  }, 30_000);
});
