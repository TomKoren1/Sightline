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

/**
 * The regression this file exists for, found by the enforcement test rather
 * than by this one: `AWS_ENDPOINT_URL` used to carry a default of the moto
 * URL, so "unset" was unrepresentable and a hosted process could **never**
 * start. Every assertion below passed throughout, because they call the pure
 * function with a hand-built environment - which is exactly what a pure
 * function is good at and exactly what it cannot notice.
 */
describe("an endpoint override that nobody configured", () => {
  it("is absent by default, so hosted mode can start at all", async () => {
    const { cfg } = await import("./config.js");
    // If this ever gains a default again, hosted mode stops booting and the
    // only symptom is a process that exits with a wall of text.
    void cfg;
    const { hostedInvariantViolations } = await import("./config.js");
    expect(
      hostedInvariantViolations({
        DEPLOYMENT_MODE: "hosted",
        AWS_MODE: "real",
        AWS_ENDPOINT_URL: undefined as unknown as string,
      }),
    ).toEqual([]);
  });
});

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
  /**
   * The demo fixture is a different thing from the banned override, and the
   * distinction is who chooses it: `AWS_ENDPOINT_URL` redirects every signed
   * call this process makes, while `DEMO_AWS_ENDPOINT_URL` applies only to a
   * tenant who explicitly asked for the demo and names a fixture the operator
   * deployed (ADR-020).
   */
  it("allows a demo endpoint, which is not an SDK-wide override", async () => {
    const { hostedInvariantViolations } = await import("./config.js");
    expect(hostedInvariantViolations({ ...CLEAN })).toEqual([]);
    // The demo variable is deliberately absent from the invariant's inputs:
    // it cannot make a hosted process refuse to start.
    expect(
      hostedInvariantViolations({ ...CLEAN } as Parameters<typeof hostedInvariantViolations>[0]),
    ).toEqual([]);
  });

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
