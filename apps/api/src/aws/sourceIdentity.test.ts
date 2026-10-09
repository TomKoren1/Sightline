/**
 * The SourceIdentity the scanner sends must satisfy the trust policy it is sent to.
 *
 * Two independent constraints have to agree, and nothing connected them:
 *
 *  1. **AWS's own charset.** Per the AssumeRole API reference, SourceIdentity
 *     permits alphanumerics, underscore and `+=,.@-` — and nothing else. A colon
 *     is rejected.
 *  2. **The customer's trust policy**, which constrains the value with
 *     `StringLike: sts:SourceIdentity: "sightline-*"` and, via a `Null` condition,
 *     requires it to be present at all.
 *
 * The template originally matched `sightline:*` — a pattern **no legal value can
 * ever satisfy**, because of (1). It went unnoticed because `credentials.ts` was
 * not sending a SourceIdentity, so the condition was never evaluated: a control
 * that was documented in an ADR, described in the onboarding UI, and dead.
 *
 * These assertions make the two artefacts fail together instead of drifting
 * apart silently.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SOURCE_IDENTITY_PREFIX, sourceIdentity, toSourceIdentity } from "../config.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const template = readFileSync(`${root}infra/readonly-role.yaml`, "utf8");

/** Exactly the characters AWS documents as permitted. Anything else is rejected. */
const AWS_ALLOWED = /^[A-Za-z0-9_+=,.@-]+$/;

/**
 * The prefix the deployed trust policy will actually enforce.
 *
 * Selects the glob pattern specifically. `sts:SourceIdentity` now appears twice
 * in the template - once in the `Null` condition as the literal "false", and
 * once in the `StringLike` as the prefix - and taking the first match read the
 * requirement flag as the prefix.
 */
function templatePrefix(): string {
  const values = [...template.matchAll(/sts:SourceIdentity: "([^"]+)"/g)].map((m) => m[1]!);
  expect(values.length, "the template no longer constrains sts:SourceIdentity").toBeGreaterThan(0);
  const globs = values.filter((v) => v.endsWith("*"));
  expect(globs, `no prefix pattern among ${JSON.stringify(values)}`).toHaveLength(1);
  return globs[0]!.slice(0, -1);
}

describe("sts:SourceIdentity", () => {
  it("sends a value AWS will accept", () => {
    const value = sourceIdentity();
    expect(value).toMatch(AWS_ALLOWED);
    // AWS length constraints: minimum 2, maximum 64.
    expect(value.length).toBeGreaterThanOrEqual(2);
    expect(value.length).toBeLessThanOrEqual(64);
    // Reserved by AWS for its own use.
    expect(value.startsWith("aws:")).toBe(false);
  });

  it("sends a value the trust policy will match", () => {
    // The assertion that matters: the two artefacts agree.
    expect(sourceIdentity().startsWith(templatePrefix())).toBe(true);
  });

  it("uses a prefix that is itself legal for AWS", () => {
    // Guards the original bug directly. `sightline:` passes a naive "does the code
    // start with the template prefix" check while being impossible to send.
    expect(templatePrefix()).toMatch(AWS_ALLOWED);
    expect(SOURCE_IDENTITY_PREFIX).toMatch(AWS_ALLOWED);
    expect(templatePrefix()).toBe(SOURCE_IDENTITY_PREFIX);
  });

  it("requires a SourceIdentity rather than merely permitting one", () => {
    // Without the Null condition, a caller that omits SourceIdentity is still
    // allowed to assume, and the customer loses the attribution the policy
    // appears to guarantee.
    expect(template, "the trust policy does not make SourceIdentity mandatory").toMatch(
      /"?Null"?:\s*\n\s*(#.*\n\s*)*sts:SourceIdentity: "false"/,
    );
  });

  it.each([
    ["a space", "alice cohen"],
    ["a colon, the character that caused this", "ops:oncall"],
    ["slashes", "a/b\\c"],
    ["only whitespace", "   "],
    ["only illegal characters", "!!!"],
    ["an email, which is already legal", "alice@Sightline"],
    ["something far too long", "x".repeat(200)],
  ])("sanitises %s into a value AWS accepts", (_label, operator) => {
    const value = toSourceIdentity(operator);
    expect(value, `operator ${JSON.stringify(operator)} produced ${value}`).toMatch(AWS_ALLOWED);
    expect(value.length).toBeGreaterThanOrEqual(2);
    expect(value.length).toBeLessThanOrEqual(64);
    expect(value.startsWith(SOURCE_IDENTITY_PREFIX)).toBe(true);
  });
});
