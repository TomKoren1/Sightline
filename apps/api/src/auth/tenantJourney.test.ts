/**
 * A new user, end to end.
 *
 * The question this answers is the one that was asked out loud after the first
 * real sign-in: *when somebody signs in with Google and connects their own AWS
 * account, do they see only their own?* Every other test here covers a layer
 * of that. This one covers the journey, through the real app, because the bug
 * that prompted it (engineering log #41) lived in the seam between layers that
 * were each individually correct.
 *
 * Sessions are minted with the real session module rather than by driving
 * Google - the OAuth round trip is tested in `google.test.ts`, and a fake
 * Google here would prove only that the fake works.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

const HAS_INFRA = !process.env["SKIP_INTEGRATION"];
const ORIGINAL = { ...process.env };

let app: FastifyInstance;
let alice: { cookie: string; tenantId: string };
let bob: { cookie: string; tenantId: string };
let pool: typeof import("../db/postgres.js").pool;

/** A signed-in user, created the way the Google callback creates one. */
async function signIn(subject: string) {
  const { findOrCreateGoogleUser } = await import("./users.js");
  const { newSession, SESSION_COOKIE } = await import("./session.js");
  const user = await findOrCreateGoogleUser({ subject, email: `${subject}@example.test` });
  return {
    tenantId: user.tenantId as string,
    cookie: `${SESSION_COOKIE}=${newSession(user.id, user.tenantId)}`,
  };
}

beforeAll(async () => {
  if (!HAS_INFRA) return;
  vi.resetModules();
  process.env["DEPLOYMENT_MODE"] = "hosted";
  process.env["AWS_MODE"] = "real";
  process.env["AWS_ENDPOINT_URL"] = "";
  process.env["AWS_ACCESS_KEY_ID"] = "";
  process.env["AWS_SECRET_ACCESS_KEY"] = "";
  process.env["SESSION_SECRET"] = "journey-test-session-secret";
  process.env["SECRETS_LOCAL_KEY"] = "journey-test-local-key";
  process.env["DEMO_AWS_ENDPOINT_URL"] = "http://localhost:5000";
  process.env["GOOGLE_CLIENT_ID"] = "journey.apps.googleusercontent.com";
  process.env["GOOGLE_CLIENT_SECRET"] = "journey-secret";
  process.env["PUBLIC_BASE_URL"] = "http://localhost:5173";

  const { buildApp } = await import("../app.js");
  app = await buildApp();
  await app.ready();

  ({ pool } = await import("../db/postgres.js"));
  alice = await signIn("journey-alice");
  bob = await signIn("journey-bob");
});

afterAll(async () => {
  if (!HAS_INFRA) return;
  await app?.close();
  await pool.query(
    `DELETE FROM tenants WHERE id IN (SELECT tenant_id FROM users WHERE provider_subject LIKE 'journey-%')`,
  );
  await pool.end();
  process.env = { ...ORIGINAL };
});

describe.runIf(HAS_INFRA)("a new user's first minutes", () => {
  it("is signed in, with a tenant of their own", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: alice.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { tenantId: string };
    expect(body.tenantId).toBe(alice.tenantId);
    expect(body.tenantId).not.toBe(bob.tenantId);
  });

  /**
   * The reported bug, as an assertion. Before the fix this returned the
   * operator's AWS account, read from the process environment.
   */
  it("has no AWS account attached, and is not shown anybody else's", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/connection",
      headers: { cookie: alice.cookie },
    });
    const body = res.json() as { roleArn: string; accountId: string | null };
    expect(body.roleArn).toBe("");
    expect(body.accountId).toBeNull();
  });

  it("cannot scan until they connect something", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/scans",
      headers: { cookie: alice.cookie },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("NO_CONNECTION");
  });

  it("gets an external id that is theirs and does not move", async () => {
    const first = await app.inject({
      method: "GET",
      url: "/api/connection/external-id",
      headers: { cookie: alice.cookie },
    });
    const second = await app.inject({
      method: "GET",
      url: "/api/connection/external-id",
      headers: { cookie: alice.cookie },
    });
    const a = (first.json() as { externalId: string }).externalId;
    const b = (second.json() as { externalId: string }).externalId;

    // A value that changed between page loads could never match the one in
    // the customer's CloudFormation stack.
    expect(a).toBe(b);

    const theirs = await app.inject({
      method: "GET",
      url: "/api/connection/external-id",
      headers: { cookie: bob.cookie },
    });
    expect((theirs.json() as { externalId: string }).externalId).not.toBe(a);
  });

  /**
   * The whole point, stated once: what the customer pasted into their
   * CloudFormation stack is what this service will present when it assumes
   * the role. The two used to be generated separately, which is AccessDenied
   * with nothing in the message to suggest why.
   */
  it("uses the id it showed them before they saved anything", async () => {
    const shown = (
      (
        await app.inject({
          method: "GET",
          url: "/api/connection/external-id",
          headers: { cookie: alice.cookie },
        })
      ).json() as { externalId: string }
    ).externalId;

    await app.inject({
      method: "POST",
      url: "/api/connection",
      headers: { cookie: alice.cookie },
      payload: { roleArn: "arn:aws:iam::444455556666:role/DaveIoReadOnlyRole" },
    });

    const { getExternalId } = await import("../tenancy/connections.js");
    expect(await getExternalId(alice.tenantId as never)).toBe(shown);
  });

  it("refuses a user ARN with the mistake named", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/connection",
      headers: { cookie: alice.cookie },
      payload: { roleArn: "arn:aws:iam::123456789012:user/somebody" },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain("can only assume a role");
  });

  it("stores the connection against them, and only them", async () => {
    const saved = await app.inject({
      method: "POST",
      url: "/api/connection",
      headers: { cookie: alice.cookie },
      payload: { roleArn: "arn:aws:iam::111122223333:role/DaveIoReadOnlyRole" },
    });
    expect(saved.statusCode).toBe(200);

    const mine = await app.inject({
      method: "GET",
      url: "/api/connection",
      headers: { cookie: alice.cookie },
    });
    expect((mine.json() as { roleArn: string }).roleArn).toContain("111122223333");

    const theirs = await app.inject({
      method: "GET",
      url: "/api/connection",
      headers: { cookie: bob.cookie },
    });
    expect((theirs.json() as { roleArn: string }).roleArn).toBe("");
  });

  /** The external id is a credential, so it must not be readable from the row. */
  it("encrypts the external id at rest", async () => {
    // On the tenant, not the connection: it identifies the customer to AWS and
    // has to exist before the role they will eventually point at does.
    const { rows } = await pool.query<{ blob: Buffer }>(
      `SELECT external_id_encrypted AS blob FROM tenants WHERE id = $1`,
      [alice.tenantId],
    );
    const stored = rows[0]!.blob.toString("utf8");
    expect(stored.startsWith("l1:")).toBe(true);

    const { getExternalId } = await import("../tenancy/connections.js");
    const plaintext = await getExternalId(alice.tenantId as never);
    expect(plaintext).toBeTruthy();
    expect(stored).not.toContain(plaintext!);
  });

  it("can explore the demo account without connecting anything", async () => {
    const switched = await app.inject({
      method: "POST",
      url: "/api/connection/mode",
      headers: { cookie: bob.cookie },
      payload: { mode: "demo" },
    });
    expect(switched.statusCode).toBe(200);

    // Now allowed to scan: there is something to scan.
    const state = await app.inject({
      method: "GET",
      url: "/api/connection",
      headers: { cookie: bob.cookie },
    });
    expect((state.json() as { mode: string }).mode).toBe("demo");

    // And the other tenant is untouched by that choice.
    const other = await app.inject({
      method: "GET",
      url: "/api/connection",
      headers: { cookie: alice.cookie },
    });
    expect((other.json() as { mode: string }).mode).toBe("real");
  });

  it("sees an empty account until they scan, not somebody else's data", async () => {
    for (const who of [alice, bob]) {
      const summary = await app.inject({
        method: "GET",
        url: "/api/summary",
        headers: { cookie: who.cookie },
      });
      const body = summary.json() as { byKind: unknown[] };
      expect(body.byKind).toEqual([]);

      const scans = await app.inject({
        method: "GET",
        url: "/api/scans",
        headers: { cookie: who.cookie },
      });
      expect((scans.json() as { scans: unknown[] }).scans).toEqual([]);
    }
  });

  it("cannot reach anything at all without signing in", async () => {
    for (const url of ["/api/summary", "/api/connection", "/api/scans"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(401);
    }
  });
});
