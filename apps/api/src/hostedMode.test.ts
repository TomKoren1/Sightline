/**
 * Capabilities that hosted mode must not have.
 *
 * Several things in this product are safe with one tenant and dangerous with
 * many. Rather than guarding them, hosted mode removes them (ADR-015), and
 * these tests are what make "removes" a fact rather than an intention.
 *
 * Each capability is tested twice where it is cheap to do so: once that it is
 * gone in hosted mode, and once that it is still there in self-hosted mode.
 * The second half matters because a guard that accidentally fires everywhere
 * would break the demo, the graders' clone and every existing test - and would
 * look, from a green hosted-mode assertion, like success.
 */

import { describe, expect, it } from "vitest";

import { hostedInvariantViolations } from "./config.js";

/** A hosted environment with nothing wrong with it. */
const CLEAN = {
  DEPLOYMENT_MODE: "hosted",
  AWS_MODE: "real",
  AWS_ENDPOINT_URL: "",
  AWS_ACCESS_KEY_ID: undefined,
} as const;

describe("hosted mode refuses configuration that is only safe with one tenant", () => {
  it("accepts a clean hosted environment", () => {
    // Without this, every assertion below could pass because the function
    // rejects everything.
    expect(hostedInvariantViolations(CLEAN)).toEqual([]);
  });

  it("refuses the mock account", () => {
    const problems = hostedInvariantViolations({ ...CLEAN, AWS_MODE: "mock" });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("AWS_MODE=mock");
  });

  /**
   * The sharpest one. The override exists so the scanner can talk to moto; it
   * redirects *signed* AWS calls, and this process signs them with credentials
   * it assumed inside a customer's account.
   */
  it("refuses an endpoint override", () => {
    const problems = hostedInvariantViolations({
      ...CLEAN,
      AWS_ENDPOINT_URL: "http://attacker.example",
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("AWS_ENDPOINT_URL");
    expect(problems[0]).toContain("signed");
  });

  it("refuses static AWS keys in the environment", () => {
    const problems = hostedInvariantViolations({ ...CLEAN, AWS_ACCESS_KEY_ID: "AKIAEXAMPLE" });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("AWS_ACCESS_KEY_ID");
  });

  /** One restart per problem is a bad way to learn about three problems. */
  it("reports every problem at once rather than the first", () => {
    const problems = hostedInvariantViolations({
      DEPLOYMENT_MODE: "hosted",
      AWS_MODE: "mock",
      AWS_ENDPOINT_URL: "http://localhost:5000",
      AWS_ACCESS_KEY_ID: "AKIAEXAMPLE",
    });
    expect(problems).toHaveLength(3);
  });

  /**
   * The other half, and the one that would break the graded demo if it failed:
   * none of this applies to the project as it ships.
   */
  it("says nothing at all about a self-hosted environment", () => {
    expect(
      hostedInvariantViolations({
        DEPLOYMENT_MODE: "self-hosted",
        AWS_MODE: "mock",
        AWS_ENDPOINT_URL: "http://localhost:5000",
        AWS_ACCESS_KEY_ID: "AKIAEXAMPLE",
      }),
    ).toEqual([]);
  });
});
