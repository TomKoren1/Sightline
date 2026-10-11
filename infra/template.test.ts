/**
 * Guards on the CloudFormation template, which grants Sightline its access and
 * which nothing in this repository executes. Two things went wrong as a result:
 *
 *  - it shipped `iam::aws:policy/ViewOnlyAccess`, which does not exist -
 *    ViewOnlyAccess is a job-function policy. A real deployment rolled back
 *    (engineering log #20).
 *  - twice the explanatory header was silently truncated, ~70 lines each time,
 *    including the rationale the README points readers at - and nothing failed,
 *    because comments have no tests.
 *
 * So both halves are asserted: the permissions are the ones claimed, and the
 * reasoning is still present.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const template = readFileSync(new URL("./readonly-role.yaml", import.meta.url), "utf8");
const original = readFileSync(new URL("./readonly-role.original.yaml", import.meta.url), "utf8");

/**
 * Resolve a folded block scalar (`key: >`) to the string CloudFormation will
 * actually receive, so length limits can be checked against the real value
 * rather than the source text.
 *
 * Folded-scalar rules, in the subset this template uses: lines at the block
 * indent are joined with a single space, and a blank line becomes a newline.
 */
function foldedScalar(source: string, key: string, indent = ""): string {
  const start = new RegExp(`^${indent}${key}: >-?\\n`, "m").exec(source);
  if (!start) throw new Error(`no folded scalar for "${key}"`);
  const rest = source.slice(start.index + start[0].length).split("\n");
  const bodyIndent = /^(\s*)/.exec(rest[0] ?? "")![1]!;
  const lines: string[] = [];
  for (const line of rest) {
    if (line.trim() === "") {
      lines.push("");
      continue;
    }
    if (!line.startsWith(bodyIndent)) break;
    lines.push(line.slice(bodyIndent.length));
  }
  while (lines.length && lines[lines.length - 1] === "") lines.pop();

  let out = "";
  for (const line of lines) {
    if (line === "") out += "\n";
    else out += (out === "" || out.endsWith("\n") ? "" : " ") + line;
  }
  return out;
}

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
    expect(template).toContain("AWS: !Ref SightlineScannerRoleArn");
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

/**
 * Length limits CloudFormation enforces.
 *
 * These are not style rules. A template whose Description exceeds 1024
 * characters is rejected outright at CreateChangeSet, before any resource is
 * looked at, with `Template format error: 'Description' length is greater than
 * 1024` - which names no resource and suggests no fix. The explanatory header
 * had grown past it, so the template could not be deployed at all, and nothing
 * here noticed because nothing here deploys it (engineering log #28).
 *
 * The fix was to move the prose into `#` comments, which have no limit and are
 * stripped before evaluation. These guards stop it drifting back.
 */
describe("the limits CloudFormation enforces", () => {
  it("keeps the template Description within 1024 characters", () => {
    const description = foldedScalar(template, "Description");
    expect(
      description.length,
      `Description is ${description.length} chars; CloudFormation rejects over 1024. ` +
        "Move the prose into # comments rather than trimming it.",
    ).toBeLessThanOrEqual(1024);
  });

  it("keeps the role's own Description within the IAM limit of 1000", () => {
    const description = foldedScalar(template, "Description", "      ");
    expect(description.length).toBeLessThanOrEqual(1000);
  });

  it("documents deployment in comments, which have no length limit", () => {
    // The prose lives above the template body now. If it migrates back into
    // Description the guard above fails, but this says why it must not.
    expect(template).toMatch(/^# .*WHY THE ORIGINAL WAS CHANGED/m);
    expect(template).toMatch(/^#.*cloudformation deploy/m);
  });
});

/**
 * `aws sts get-caller-identity` returns an `arn:aws:sts::...` session ARN, and
 * pasting that into SightlineScannerRoleArn is the mistake this template's own
 * AllowedPattern rejects. Every ARN we show as an example must be the `iam`
 * principal form, or we are teaching the error.
 */
describe("the examples are principal ARNs, not session ARNs", () => {
  it("shows no arn:aws:sts:: ARN as a parameter value", () => {
    const badExamples = template
      .split("\n")
      .filter((line) => /SightlineScannerRoleArn=\s*arn:aws:sts::/.test(line));
    expect(badExamples).toEqual([]);
  });

  it("explains the sts-to-iam conversion, since the error message does not", () => {
    expect(template).toContain("assumed-role");
  });
});
