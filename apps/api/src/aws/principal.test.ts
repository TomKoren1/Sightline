/**
 * The conversions here are one character apart from the values that do not
 * work, which is exactly why they are tested rather than inlined.
 */

import { describe, expect, it } from "vitest";

import {
  SCANNER_PRINCIPAL_PATTERN,
  assumablePrincipalArn,
  validateAssumeRoleTarget,
} from "./principal.js";

describe("assumablePrincipalArn", () => {
  it("converts an assumed-role session ARN to the role behind it", () => {
    const result = assumablePrincipalArn(
      "arn:aws:sts::672299759593:assumed-role/AdminRole/tom@example.com",
    );
    expect(result).toMatchObject({
      ok: true,
      principalArn: "arn:aws:iam::672299759593:role/AdminRole",
      converted: true,
    });
  });

  /** The shape moto returns, and the one that was pasted into a real deploy. */
  it("converts the sts user ARN the mock reports", () => {
    const result = assumablePrincipalArn("arn:aws:sts::123456789012:user/moto");
    expect(result).toMatchObject({
      ok: true,
      principalArn: "arn:aws:iam::123456789012:user/moto",
      converted: true,
    });
  });

  it("leaves a real IAM user ARN alone", () => {
    const arn = "arn:aws:iam::672299759593:user/sightline-operator";
    expect(assumablePrincipalArn(arn)).toEqual({ ok: true, principalArn: arn, converted: false });
  });

  it("leaves a real IAM role ARN alone", () => {
    const arn = "arn:aws:iam::672299759593:role/SightlineScanner";
    expect(assumablePrincipalArn(arn)).toEqual({ ok: true, principalArn: arn, converted: false });
  });

  it("preserves a non-commercial partition", () => {
    const result = assumablePrincipalArn(
      "arn:aws-us-gov:sts::672299759593:assumed-role/Scanner/session",
    );
    expect(result).toMatchObject({ principalArn: "arn:aws-us-gov:iam::672299759593:role/Scanner" });
  });

  it("warns that a converted session ARN loses any IAM path", () => {
    const result = assumablePrincipalArn("arn:aws:sts::672299759593:assumed-role/Foo/s");
    expect(result.ok && result.note).toMatch(/path/i);
  });

  it.each([
    ["the account root", "arn:aws:iam::672299759593:root", /root/i],
    ["a federated session", "arn:aws:sts::672299759593:federated-user/tom", /federated/i],
    ["a non-ARN", "not-an-arn", /not an ARN/i],
    ["nothing at all", null, /credentials/i],
  ])("refuses %s with a reason rather than a guess", (_label, input, expected) => {
    const result = assumablePrincipalArn(input);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(expected);
  });

  /**
   * The guarantee that matters: whatever this returns can be pasted into the
   * CloudFormation parameter without tripping its AllowedPattern.
   */
  it("only ever returns ARNs the template's AllowedPattern accepts", () => {
    for (const identity of [
      "arn:aws:sts::123456789012:assumed-role/AdminRole/session",
      "arn:aws:sts::123456789012:user/moto",
      "arn:aws:iam::123456789012:user/tom",
      "arn:aws:iam::123456789012:role/Scanner",
    ]) {
      const result = assumablePrincipalArn(identity);
      expect(result.ok, identity).toBe(true);
      expect(result.ok && SCANNER_PRINCIPAL_PATTERN.test(result.principalArn), identity).toBe(true);
    }
  });
});

describe("validateAssumeRoleTarget", () => {
  it("accepts a role ARN", () => {
    expect(
      validateAssumeRoleTarget("arn:aws:iam::672299759593:role/SightlineReadOnlyRole"),
    ).toEqual({
      ok: true,
    });
  });

  /**
   * The exact misconfiguration that produced a confusing failure: the scanner
   * principal pasted into the target-role variable.
   */
  it("rejects a user ARN and names the two-role mix-up", () => {
    const result = validateAssumeRoleTarget("arn:aws:iam::672299759593:user/sightline-operator");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/can only assume a role/);
    expect(!result.ok && result.reason).toMatch(/RoleArn output/);
  });

  it("rejects anything that is not an IAM ARN", () => {
    expect(validateAssumeRoleTarget("SightlineReadOnlyRole").ok).toBe(false);
  });
});
