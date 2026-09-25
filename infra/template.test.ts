/**
 * Guards on the CloudFormation template.
 *
 * The template is the artefact that grants dave.io its access, and the README
 * and ADR-007 both argue in detail about what it permits. Nothing in this
 * repository executes it, so for a long time nothing checked that any of that
 * was true - and two separate things went wrong as a result.
 *
 * It shipped with `arn:aws:iam::aws:policy/ViewOnlyAccess`, which does not
 * exist: ViewOnlyAccess is a job-function policy and lives under
 * `job-function/`. A real deployment failed and rolled back (engineering log
 * #20).
 *
 * And twice the explanatory header was silently truncated - once demonstrably
 * by Prettier reformatting a folded block scalar (#18), once by something never
 * identified. Both times ~70 lines vanished, including the entire rationale the
 * README points readers at, and nothing failed, because comments have no tests.
 *
 * So these tests assert both halves: that the permissions are the ones we
 * claim, and that the reasoning is still present. A document nobody checks
 * rots; this is the cheapest possible check.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const template = readFileSync(new URL("./readonly-role.yaml", import.meta.url), "utf8");
const original = readFileSync(new URL("./readonly-role.original.yaml", import.meta.url), "utf8");

describe("readonly-role.yaml structure", () => {
  it("has every required top-level section", () => {
    for (const key of [
      "AWSTemplateFormatVersion",
      "Parameters",
      "Conditions",
      "Resources",
      "Outputs",
    ]) {
      expect(template, key).toMatch(new RegExp(`^${key}:`, "m"));
    }
  });

  it("creates exactly one IAM role", () => {
    expect(template.match(/Type: AWS::IAM::Role/g)).toHaveLength(1);
  });
});

describe("the permissions ADR-007 claims", () => {
  /**
   * The bug a real deployment found. ViewOnlyAccess is a job-function policy;
   * the root-path ARN 404s, and SecurityAudit on the line above *is* at the
   * root, which is what makes it easy to get wrong.
   */
  it("references ViewOnlyAccess at its real job-function path", () => {
    expect(template).toContain("arn:aws:iam::aws:policy/job-function/ViewOnlyAccess");
    expect(template).not.toMatch(/policy\/ViewOnlyAccess/);
  });

  it("attaches SecurityAudit at the root path, where it really is", () => {
    expect(template).toContain("arn:aws:iam::aws:policy/SecurityAudit");
  });

  it("does not grant ReadOnlyAccess, which is the whole point of replacing it", () => {
    expect(template).not.toContain("arn:aws:iam::aws:policy/ReadOnlyAccess");
    // The original did, and is kept for comparison.
    expect(original).toContain("arn:aws:iam::aws:policy/ReadOnlyAccess");
  });

  it("explicitly denies every data-plane read the README names", () => {
    for (const action of [
      "s3:GetObject",
      "dynamodb:GetItem",
      "secretsmanager:GetSecretValue",
      "ssm:GetParameter",
      "kms:Decrypt",
      "lambda:GetFunction",
      "sqs:ReceiveMessage",
      "ec2:GetPasswordData",
    ]) {
      expect(template, action).toContain(`"${action}"`);
    }
    expect(template).toContain("Effect: Deny");
  });

  it("grants the inventory reads the scanner actually makes", () => {
    for (const action of ["s3:GetBucketPolicyStatus", "s3:GetBucketPublicAccessBlock"]) {
      expect(template, action).toContain(action);
    }
  });
});

describe("the trust model ADR-007 claims", () => {
  it("scopes trust to a named principal rather than an account root", () => {
    expect(template).toContain("AWS: !Ref DaveIoScannerRoleArn");
    expect(template).not.toMatch(/:root"/);
    // The original trusted the whole account, which is what was changed.
    expect(original).toMatch(/:root"/);
  });

  it("requires the external id", () => {
    expect(template).toContain("sts:ExternalId: !Ref ExternalId");
  });

  it("supports SourceIdentity so customers can attribute scans", () => {
    expect(template).toContain("sts:SetSourceIdentity");
  });

  it("accepts a user ARN, so the project can run against your own account", () => {
    expect(template).toMatch(/AllowedPattern:.*\(role\|user\)/);
  });
});

/**
 * Content guards. These would look odd in most repositories; here they exist
 * because this exact content has been silently deleted twice.
 */
describe("the reasoning survives", () => {
  it.each([
    ["the rationale header", "WHY THE ORIGINAL WAS CHANGED"],
    ["the sqs:ReceiveMessage argument", "visibility timeout"],
    ["the :root explanation", "does not mean"],
    ["the two-role warning", "TWO ROLES ARE INVOLVED"],
    ["the verification command", "simulate-principal-policy"],
  ])("still contains %s", (_label, needle) => {
    expect(template).toContain(needle);
  });

  it("has not been truncated", () => {
    // It was 287 lines when these guards were written. A large drop means
    // something reformatted or mangled it rather than edited it.
    expect(template.split("\n").length).toBeGreaterThan(250);
  });
});
