/**
 * Switching to the demo account, per tenant.
 *
 * The single-tenant toggle this replaces was a module-level flag. That is
 * honest for one operator and wrong for a service: with several tenants on one
 * process, one person clicking "Demo" would change what everybody else is
 * looking at, and - worse - which AWS account their next scan reads
 * (ADR-020).
 *
 * So the property under test is not "the toggle works". It is **that one
 * tenant's choice does not reach another tenant**, which is the thing a flag
 * cannot promise and a column can.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL = { ...process.env };
const HAS_INFRA = !process.env["SKIP_INTEGRATION"];

const T1 = "d3111111-0000-4000-8000-000000000001";
const T2 = "d3222222-0000-4000-8000-000000000002";

function hostedEnv() {
  process.env["DEPLOYMENT_MODE"] = "hosted";
  // No KMS in a test run, and no tenant to endanger: the hosted invariant
  // requires this to be said out loud rather than assumed.
  process.env["SECRETS_ALLOW_LOCAL_KEY"] = "true";
  process.env["AWS_MODE"] = "real";
  process.env["AWS_ENDPOINT_URL"] = "";
  process.env["AWS_ACCESS_KEY_ID"] = "";
  process.env["AWS_SECRET_ACCESS_KEY"] = "";
  process.env["SECRETS_LOCAL_KEY"] = "test-secret-key-for-local-encryption";
  process.env["DEMO_AWS_ENDPOINT_URL"] = "http://localhost:5000";
  process.env["DEMO_AWS_ACCOUNT_ID"] = "123456789012";
}

beforeEach(() => {
  vi.resetModules();
  hostedEnv();
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.resetModules();
});

describe("the demo account as a connection", () => {
  it("points at the configured fixture, not at anything a tenant supplied", async () => {
    const { demoConnection } = await import("../aws/credentials.js");
    const demo = demoConnection();
    expect(demo.endpoint).toBe("http://localhost:5000");
    expect(demo.roleArn).toContain("123456789012");
    // Signed with fixture credentials, so the SDK can never fall through to a
    // real credential chain while talking to the demo.
    expect(demo.sourceCredentials).toBeDefined();
  });

  it("is refused when the deployment has no demo configured", async () => {
    delete process.env["DEMO_AWS_ENDPOINT_URL"];
    vi.resetModules();
    const { demoConnection, DemoUnavailableError } = await import("../aws/credentials.js");
    expect(() => demoConnection()).toThrow(DemoUnavailableError);
  });

  /**
   * The demo endpoint is a different kind of thing from the endpoint override
   * hosted mode bans, and the difference is who chooses it: the banned one
   * redirects every signed call the process makes; this one applies only to a
   * tenant who asked for it.
   */
  it("does not stop a hosted process from starting, unlike AWS_ENDPOINT_URL", async () => {
    const { hostedInvariantViolations, cfg } = await import("../config.js");
    expect(cfg.DEMO_AWS_ENDPOINT_URL).toBe("http://localhost:5000");
    expect(hostedInvariantViolations(cfg)).toEqual([]);
  });
});

describe.runIf(HAS_INFRA)("two tenants, two choices, one process", () => {
  beforeEach(async () => {
    const { pool } = await import("../db/postgres.js");
    for (const [id, slug] of [
      [T1, "demo-test-1"],
      [T2, "demo-test-2"],
    ]) {
      await pool.query(
        `INSERT INTO tenants (id, slug, display_name) VALUES ($1, $2, $2)
         ON CONFLICT (id) DO UPDATE SET demo_mode = false`,
        [id, slug],
      );
    }
  });

  afterAll(async () => {
    const { pool } = await import("../db/postgres.js");
    await pool.query(`DELETE FROM tenants WHERE id IN ($1,$2)`, [T1, T2]);
    await pool.end();
  });

  it("remembers the choice per tenant", async () => {
    const { getTenant, setDemoMode } = await import("./tenants.js");
    await setDemoMode(T1 as never, true);

    expect((await getTenant(T1 as never))?.demoMode).toBe(true);
    expect((await getTenant(T2 as never))?.demoMode).toBe(false);
  });

  /**
   * The failure a module-level flag would produce: tenant 1 switches, and
   * tenant 2's next scan silently reads the demo account instead of theirs.
   */
  it("does not point the other tenant at the demo account", async () => {
    const { setDemoMode } = await import("./tenants.js");
    const { resolveConnection, NoConnectionError } = await import("../aws/credentials.js");

    await setDemoMode(T1 as never, true);

    const forOne = await resolveConnection(T1 as never);
    expect(forOne.endpoint).toBe("http://localhost:5000");

    // Tenant 2 has connected nothing, so they get the refusal - not the demo,
    // and not somebody's real account either.
    await expect(resolveConnection(T2 as never)).rejects.toBeInstanceOf(NoConnectionError);
  });

  it("switches back", async () => {
    const { getTenant, setDemoMode } = await import("./tenants.js");
    await setDemoMode(T1 as never, true);
    await setDemoMode(T1 as never, false);
    expect((await getTenant(T1 as never))?.demoMode).toBe(false);
  });
});
