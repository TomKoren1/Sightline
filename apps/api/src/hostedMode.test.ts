import { describe, expect, it } from "vitest";

import { assertHostedInvariants, hostedInvariantViolations, type Env } from "./hostedMode.js";

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

  it("reports every problem at once", () => {
    // One restart per problem is a bad way to learn about three.
    const broken = hostedInvariantViolations({
      DEPLOYMENT_MODE: "hosted",
      AWS_ENDPOINT_URL: "http://moto:5000",
    });
    expect(broken.length).toBeGreaterThan(4);
  });

  it("throws with every reason numbered", () => {
    expect(() => assertHostedInvariants(valid)).not.toThrow();
    expect(() => assertHostedInvariants({ DEPLOYMENT_MODE: "hosted" })).toThrow(
      /cannot start with this configuration/,
    );
  });
});
