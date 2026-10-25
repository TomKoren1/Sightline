import { afterEach, describe, expect, it, vi } from "vitest";

import {
  apiPrivilegeWarnings,
  assertHostedInvariants,
  hostedInvariantViolations,
  type Env,
} from "./hostedMode.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

/** A hosted environment with nothing wrong with it. */
const valid: Env = {
  DEPLOYMENT_MODE: "hosted",
  AWS_KMS_KEY_ID: "arn:aws:kms:us-east-1:672299759593:key/11111111-2222-3333-4444-555555555555",
  SCANNER_PRINCIPAL_ARN: "arn:aws:iam::672299759593:user/SightlineScanner",
  ROLE_TEMPLATE_URL: "https://sightline-templates.s3.amazonaws.com/v1/readonly-role.yaml",
  SESSION_SECRET: "s".repeat(48),
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_CLIENT_SECRET: "client-secret",
  PUBLIC_BASE_URL: "https://sightline.example",
  DATABASE_URL: "postgres://sightline:owner@db:5432/sightline",
  DATABASE_URL_APP: "postgres://sightline_app:restricted@db:5432/sightline",
};

const reasons = (env: Env) => hostedInvariantViolations(env).join("\n");

describe("hosted invariants", () => {
  it("accepts a complete hosted configuration", () => {
    // The baseline has to pass, or every assertion below is vacuous.
    expect(hostedInvariantViolations(valid)).toEqual([]);
  });

  /**
   * The half that is easy to forget.
   *
   * A guard that accidentally fired everywhere would break the demo, a fresh
   * clone and every existing test - while looking like success from a green
   * hosted assertion.
   */
  it("says nothing at all about a self-hosted deployment", () => {
    expect(hostedInvariantViolations({})).toEqual([]);
    expect(hostedInvariantViolations({ DEPLOYMENT_MODE: "self-hosted" })).toEqual([]);
    // The things hosted mode refuses are all normal self-hosted configuration.
    expect(
      hostedInvariantViolations({
        DEPLOYMENT_MODE: "self-hosted",
        AWS_ENDPOINT_URL: "http://localhost:5000",
        AWS_MODE: "mock",
        AWS_ACCESS_KEY_ID: "mock",
        PUBLIC_BASE_URL: "http://localhost:5173",
      }),
    ).toEqual([]);
  });

  describe("the restricted database role", () => {
    it("is required, because the owner bypasses every policy", () => {
      const { DATABASE_URL_APP: _omitted, ...withoutIt } = valid;
      /**
       * The failure this refuses is entirely silent: the policies are
       * installed, they show up in `\d`, and they filter nothing because the
       * owner here is a superuser - for whom even FORCE ROW LEVEL SECURITY does
       * not apply. There is no symptom until a tenant sees another's inventory.
       */
      expect(reasons(withoutIt)).toMatch(/DATABASE_URL_APP is required/);
      // And it says what to run, because "configure a role" is not an action.
      expect(reasons(withoutIt)).toMatch(/db:app-role/);
    });

    it("must not simply repeat the owner's connection string", () => {
      // The way somebody satisfies the check above without satisfying the
      // requirement: set it, to the same thing.
      expect(reasons({ ...valid, DATABASE_URL_APP: valid.DATABASE_URL })).toMatch(
        /same as DATABASE_URL/,
      );
    });
  });

  it("refuses an SDK-wide endpoint override", () => {
    expect(reasons({ ...valid, AWS_ENDPOINT_URL: "http://moto:5000" })).toMatch(
      /AWS_ENDPOINT_URL must not be set/,
    );
    // And names the variable that is allowed instead, because the reader's
    // next question is how to run a demo at all.
    expect(reasons({ ...valid, AWS_ENDPOINT_URL: "http://moto:5000" })).toMatch(
      /DEMO_AWS_ENDPOINT_URL/,
    );
  });

  it("refuses the process-wide mock toggle", () => {
    expect(reasons({ ...valid, AWS_MODE: "mock" })).toMatch(/process-wide/);
    expect(hostedInvariantViolations({ ...valid, AWS_MODE: "real" })).toEqual([]);
  });

  it("refuses a placeholder access key but accepts a real one", () => {
    expect(reasons({ ...valid, AWS_ACCESS_KEY_ID: "mock" })).toMatch(/not a real AWS key/);
    // The platform identity on a cluster with no IRSA *is* a static key, so a
    // real one must be accepted - banning every key made hosted undeployable.
    expect(
      hostedInvariantViolations({ ...valid, AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE" }),
    ).toEqual([]);
  });

  it("requires KMS rather than a key beside the database", () => {
    expect(reasons({ ...valid, AWS_KMS_KEY_ID: "" })).toMatch(/AWS_KMS_KEY_ID is required/);
    // A local key is not an acceptable substitute in hosted mode.
    expect(reasons({ ...valid, AWS_KMS_KEY_ID: "", SECRETS_LOCAL_KEY: "x".repeat(40) })).toMatch(
      /AWS_KMS_KEY_ID is required/,
    );
  });

  it("requires the two values onboarding cannot be built without", () => {
    expect(reasons({ ...valid, SCANNER_PRINCIPAL_ARN: "" })).toMatch(/SCANNER_PRINCIPAL_ARN/);
    expect(reasons({ ...valid, ROLE_TEMPLATE_URL: "" })).toMatch(/ROLE_TEMPLATE_URL/);
  });

  it("requires at least one sign-in provider", () => {
    const none = { ...valid, GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "" };
    expect(reasons(none)).toMatch(/No sign-in provider is configured/);
    // Either one on its own is enough; half of one is not.
    expect(
      hostedInvariantViolations({ ...none, GITHUB_CLIENT_ID: "a", GITHUB_CLIENT_SECRET: "b" }),
    ).toEqual([]);
    expect(reasons({ ...none, GITHUB_CLIENT_ID: "a" })).toMatch(/No sign-in provider/);
  });

  it("requires https, because the cookie's Secure flag follows the scheme", () => {
    expect(reasons({ ...valid, PUBLIC_BASE_URL: "http://sightline.example" })).toMatch(
      /must be https/,
    );
    expect(reasons({ ...valid, PUBLIC_BASE_URL: "" })).toMatch(/PUBLIC_BASE_URL is required/);
  });

  it("allows plain http on loopback, which nobody else can reach", () => {
    expect(
      hostedInvariantViolations({ ...valid, PUBLIC_BASE_URL: "http://localhost:5173" }),
    ).toEqual([]);
    expect(reasons({ ...valid, PUBLIC_BASE_URL: "http://localhost.example" })).toMatch(
      /must be https/,
    );
  });

  it("refuses Roles Anywhere half configured, and accepts all five or none", () => {
    const all = {
      ROLES_ANYWHERE_CERTIFICATE: "/etc/c.pem",
      ROLES_ANYWHERE_PRIVATE_KEY: "/etc/k.pem",
      ROLES_ANYWHERE_TRUST_ANCHOR_ARN: "arn:aws:rolesanywhere:us-east-1:1:trust-anchor/a",
      ROLES_ANYWHERE_PROFILE_ARN: "arn:aws:rolesanywhere:us-east-1:1:profile/p",
      ROLES_ANYWHERE_ROLE_ARN: "arn:aws:iam::1:role/SightlineScanner",
    };
    expect(hostedInvariantViolations({ ...valid, ...all })).toEqual([]);
    expect(reasons({ ...valid, ...all, ROLES_ANYWHERE_PROFILE_ARN: "" })).toMatch(
      /half configured: ROLES_ANYWHERE_PROFILE_ARN missing/,
    );
  });

  it("refuses the browser suite's stand-ins anywhere but loopback", () => {
    for (const key of ["KMS_ENDPOINT_URL", "E2E_IDENTITY_PROVIDER_URL"]) {
      expect(reasons({ ...valid, [key]: "http://127.0.0.1:4010" })).toMatch(/test seam/);
      expect(
        hostedInvariantViolations({
          ...valid,
          PUBLIC_BASE_URL: "http://127.0.0.1:5173",
          [key]: "http://127.0.0.1:4010",
        }),
      ).toEqual([]);
    }
  });

  it("reports every problem at once", () => {
    // One restart per problem is a bad way to learn about three.
    const broken = hostedInvariantViolations({
      DEPLOYMENT_MODE: "hosted",
      AWS_ENDPOINT_URL: "http://moto:5000",
    });
    expect(broken.length).toBeGreaterThan(4);
  });

  /**
   * The gap these invariants do not close on their own.
   *
   * They read the **raw** environment, deliberately - several of these keys
   * carry a Zod default, so "unset" is not representable after parsing. The
   * consequence is that an *unset* `AWS_MODE` passes the check against `"mock"`
   * and then parses to the `mock` default, leaving a public deployment
   * believing it is pointed at a local fixture.
   *
   * Found by booting hosted mode and watching the legacy connection test aim
   * its STS calls at `http://localhost:5000`. Pinned here because the fix lives
   * in `isMock()` rather than in the list above, and nothing else would notice
   * if it were reverted.
   */
  it("leaves no mock path reachable in hosted mode", async () => {
    // The worst case: the parsed configuration says `mock` outright. How it got
    // there - a Zod default, or a file - is not the point. The point is that
    // hosted mode must not act on it.
    process.env = { ...ORIGINAL_ENV, ...valid, AWS_MODE: "mock" };
    delete process.env["AWS_ENDPOINT_URL"];
    vi.resetModules();

    const hosted = await import("./config.js");
    expect(hosted.isHosted()).toBe(true);
    expect(hosted.cfg.AWS_MODE).toBe("mock");
    expect((await import("../aws/settings.js")).isMock()).toBe(false);
  });

  it("still means what it says in a self-hosted deployment", async () => {
    // The other half: a clone pointed at the fixture must keep working. A fix
    // that answered "no" everywhere would break the demo while looking like
    // success from the assertion above.
    process.env = { ...ORIGINAL_ENV, AWS_MODE: "mock" };
    delete process.env["DEPLOYMENT_MODE"];
    vi.resetModules();

    const selfHosted = await import("./config.js");
    expect(selfHosted.isHosted()).toBe(false);
    expect((await import("../aws/settings.js")).isMock()).toBe(true);
  });

  it("throws with every reason numbered", () => {
    expect(() => assertHostedInvariants(valid)).not.toThrow();
    expect(() => assertHostedInvariants({ DEPLOYMENT_MODE: "hosted" })).toThrow(
      /cannot start with this configuration/,
    );
  });
});

describe("API privilege warnings", () => {
  const SCANNER_KEY = { AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE", AWS_SECRET_ACCESS_KEY: "x" };

  it("says nothing about a correctly split deployment", () => {
    expect(apiPrivilegeWarnings(valid, { workerMode: "separate", ownsSchema: false })).toEqual([]);
  });

  it("flags the scanner identity in an API that runs no scans", () => {
    const [warning] = apiPrivilegeWarnings(
      { ...valid, ...SCANNER_KEY },
      { workerMode: "separate", ownsSchema: false },
    );
    expect(warning).toContain("AWS_ACCESS_KEY_ID");
  });

  it("allows it where the API is the worker", () => {
    expect(
      apiPrivilegeWarnings(
        { ...valid, ...SCANNER_KEY },
        { workerMode: "embedded", ownsSchema: false },
      ),
    ).toEqual([]);
  });

  it("flags an API connected as the schema's owner", () => {
    const [warning] = apiPrivilegeWarnings(valid, { workerMode: "separate", ownsSchema: true });
    expect(warning).toContain("sightline_system");
  });

  it("stays out of a self-hosted clone, which is one process with every role", () => {
    expect(
      apiPrivilegeWarnings(
        { ...SCANNER_KEY, DEPLOYMENT_MODE: "local" },
        { workerMode: "embedded", ownsSchema: true },
      ),
    ).toEqual([]);
  });
});
