/**
 * That the hook actually stops requests.
 *
 * Every other auth test here checks a function in isolation. This one drives
 * the real Fastify app, because the question it answers is not "does
 * `decodeSession` work" but "can somebody read a tenant's inventory without
 * signing in" - and that depends on the hook being registered, registered
 * *before* the routes, and not quietly exempting something.
 *
 * It asserts on status codes rather than bodies, so it keeps working when the
 * handlers behind these routes change.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

const ORIGINAL = { ...process.env };

afterEach(async () => {
  process.env = { ...ORIGINAL };
  vi.resetModules();
});

async function hostedApp(): Promise<FastifyInstance> {
  vi.resetModules();
  process.env["DEPLOYMENT_MODE"] = "hosted";
  // No KMS in a test run, and no tenant to endanger: the hosted invariant
  // requires this to be said out loud rather than assumed.
  process.env["SECRETS_ALLOW_LOCAL_KEY"] = "true";
  process.env["AWS_MODE"] = "real";
  // Blank, not deleted: `.env` is re-read on every module reset and dotenv
  // fills in anything absent, so deleting a variable puts it straight back.
  // A blank value is "present and empty", which `blankAsUnset` treats as unset.
  process.env["AWS_ENDPOINT_URL"] = "";
  process.env["AWS_ACCESS_KEY_ID"] = "";
  process.env["AWS_SECRET_ACCESS_KEY"] = "";
  process.env["SESSION_SECRET"] = "test-session-secret-not-a-real-one";
  process.env["GOOGLE_CLIENT_ID"] = "1234.apps.googleusercontent.com";
  process.env["GOOGLE_CLIENT_SECRET"] = "not-a-real-client-secret";
  process.env["PUBLIC_BASE_URL"] = "https://dave.example";

  const { buildApp } = await import("../app.js");
  const app = await buildApp();
  await app.ready();
  return app;
}

/** Every route that reads or writes a tenant's data. */
const PROTECTED = [
  ["GET", "/api/summary"],
  ["GET", "/api/graph"],
  ["GET", "/api/findings"],
  ["GET", "/api/scans"],
  ["GET", "/api/scans/latest"],
  ["GET", "/api/search?q=test"],
  ["GET", "/api/resources/arn%3Aaws%3As3%3A%3A%3Aexample"],
  ["POST", "/api/scans"],
  ["POST", "/api/chat"],
  ["POST", "/api/evals/ground-truth"],
] as const;

describe("hosted mode, with no session", () => {
  it.each(PROTECTED.map(([method, url]) => [`${method} ${url}`, method, url] as const))(
    "%s is refused",
    async (_label, method, url) => {
      const app = await hostedApp();
      try {
        const res = await app.inject({ method, url });
        // 401 and nothing else: a 500 would mean the handler ran and failed
        // for its own reasons, which is not the same as being protected, and
        // a 200 would mean it ran successfully without a caller.
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    },
  );

  it("does not reveal whether data exists in the refusal", async () => {
    const app = await hostedApp();
    try {
      const res = await app.inject({ method: "GET", url: "/api/summary" });
      const body = res.json() as { error: string; signInUrl?: string };
      expect(body.error).toBe("Not signed in");
      expect(body.signInUrl).toBe("/auth/google");
    } finally {
      await app.close();
    }
  });
});

describe("what must stay reachable without a session", () => {
  it("serves health, so the cluster can probe it", async () => {
    const app = await hostedApp();
    try {
      const res = await app.inject({ method: "GET", url: "/api/health" });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("serves /api/me, because the UI asks it whether to show a sign-in button", async () => {
    const app = await hostedApp();
    try {
      const res = await app.inject({ method: "GET", url: "/api/me" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { user: unknown; tenantId: unknown };
      expect(body.user).toBeNull();
      expect(body.tenantId).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("starts the sign-in it is telling people to use", async () => {
    const app = await hostedApp();
    try {
      const res = await app.inject({ method: "GET", url: "/auth/google" });
      expect(res.statusCode).toBe(302);
      const location = res.headers["location"] as string;
      expect(location).toContain("accounts.google.com");
      expect(location).toContain("client_id=1234.apps.googleusercontent.com");
    } finally {
      await app.close();
    }
  });
});

/**
 * The half that would break the graded project if the hook were too eager.
 * Self-hosted has one tenant and no sign-in, and must not start demanding one.
 */
describe("self-hosted is unaffected", () => {
  it("does not require a session for tenant data", async () => {
    vi.resetModules();
    process.env["DEPLOYMENT_MODE"] = "self-hosted";
    const { buildApp } = await import("../app.js");
    const app = await buildApp();
    await app.ready();
    try {
      const res = await app.inject({ method: "GET", url: "/api/scans/latest" });
      // 200 with data, or 500 if no database is running here - either way it
      // reached the handler, which is what this asserts. Never 401.
      expect(res.statusCode).not.toBe(401);
    } finally {
      await app.close();
    }
  });

  it("reports itself as single-tenant", async () => {
    vi.resetModules();
    process.env["DEPLOYMENT_MODE"] = "self-hosted";
    const { buildApp } = await import("../app.js");
    const app = await buildApp();
    await app.ready();
    try {
      const res = await app.inject({ method: "GET", url: "/api/me" });
      const body = res.json() as { mode: string; tenantId: string };
      expect(body.mode).toBe("self-hosted");
      expect(body.tenantId).toBe("00000000-0000-0000-0000-000000000001");
    } finally {
      await app.close();
    }
  });
});
