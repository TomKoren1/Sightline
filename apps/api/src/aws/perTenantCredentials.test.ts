/**
 * Whose AWS account a tenant's scan reaches.
 *
 * The first hosted sign-in showed a brand-new tenant the operator's own AWS
 * account, because the connection came from process configuration: one module
 * -level `cached` session and an `activeConnection()` read from the
 * environment. Both are the same bug wearing different clothes - **ambient
 * state in a process that serves several tenants** (ADR-019).
 *
 * These are the two assertions that would have caught it, and neither needs
 * AWS: a tenant with no connection must be refused rather than served
 * something, and the refusal must not be a generic error that a caller could
 * mistake for "no data".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL = { ...process.env };

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.resetModules();
});

async function hosted() {
  vi.resetModules();
  process.env["DEPLOYMENT_MODE"] = "hosted";
  // No KMS in a test run, and no tenant to endanger: the hosted invariant
  // requires this to be said out loud rather than assumed.
  process.env["SECRETS_ALLOW_LOCAL_KEY"] = "true";
  process.env["AWS_MODE"] = "real";
  process.env["AWS_ENDPOINT_URL"] = "";
  process.env["AWS_ACCESS_KEY_ID"] = "";
  process.env["AWS_SECRET_ACCESS_KEY"] = "";
  process.env["SECRETS_LOCAL_KEY"] = "test-secret-key-for-local-encryption";
  // Configuration that *would* be used if anything still fell back to it.
  process.env["AWS_TARGET_ROLE_ARN"] = "arn:aws:iam::999999999999:role/OperatorsOwnRole";
  process.env["AWS_EXTERNAL_ID"] = "the-operators-own-external-id";
  return import("./credentials.js");
}

const TENANT_WITH_NO_CONNECTION = "cccccccc-0000-4000-8000-00000000000c" as never;

describe("a hosted tenant that has not connected an account", () => {
  it("is refused, not quietly given the operator's account", async () => {
    const { resolveConnection, NoConnectionError } = await hosted();
    await expect(resolveConnection(TENANT_WITH_NO_CONNECTION)).rejects.toBeInstanceOf(
      NoConnectionError,
    );
  });

  /**
   * The specific failure to guard against: `AWS_TARGET_ROLE_ARN` is set in
   * this process's environment, and the old code path would have used it.
   */
  it("never returns the role ARN configured in the environment", async () => {
    const { resolveConnection } = await hosted();
    await expect(resolveConnection(TENANT_WITH_NO_CONNECTION)).rejects.toThrow();

    // Belt and braces: if this ever starts resolving, it must not be that ARN.
    const resolved = await resolveConnection(TENANT_WITH_NO_CONNECTION).catch(() => null);
    expect(resolved?.roleArn).not.toBe("arn:aws:iam::999999999999:role/OperatorsOwnRole");
  });

  it("carries a code the UI can act on rather than a bare message", async () => {
    const { resolveConnection } = await hosted();
    const err = await resolveConnection(TENANT_WITH_NO_CONNECTION).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("NO_CONNECTION");
    expect((err as { statusCode?: number }).statusCode).toBe(409);
  });
});

/**
 * The half that keeps the graded project working: self-hosted has one tenant
 * and reads its connection from configuration, exactly as it always has.
 */
describe("self-hosted", () => {
  it("still resolves the configured connection", async () => {
    vi.resetModules();
    process.env["DEPLOYMENT_MODE"] = "self-hosted";
    process.env["AWS_MODE"] = "real";
    process.env["AWS_TARGET_ROLE_ARN"] = "arn:aws:iam::123456789012:role/DaveIoReadOnlyRole";
    const { resolveConnection } = await import("./credentials.js");
    const { LOCAL_TENANT } = await import("../tenancy/tenant.js");

    const resolved = await resolveConnection(LOCAL_TENANT);
    expect(resolved.roleArn).toBe("arn:aws:iam::123456789012:role/DaveIoReadOnlyRole");
  });
});
