import { describe, expect, it } from "vitest";
import { CitationTracker, validateCitations } from "./citations.js";

const ARN_A = "arn:aws:s3:::northwind-public-assets";
const ARN_B = "arn:aws:ec2:us-east-1:123456789012:instance/i-0abc";
const FAKE = "arn:aws:s3:::bucket-that-does-not-exist";

const known = new Map([
  [ARN_A, { arn: ARN_A, name: "northwind-public-assets", kind: "S3Bucket" }],
  [ARN_B, { arn: ARN_B, name: "prod-web-1", kind: "Ec2Instance" }],
]);

describe("validateCitations", () => {
  it("accepts an ARN a tool returned", () => {
    const { citations, warnings } = validateCitations(
      `The bucket ${ARN_A} is public.`,
      new Set([ARN_A]),
      known,
    );
    expect(citations).toContainEqual({
      arn: ARN_A,
      valid: true,
      kind: "S3Bucket",
      name: "northwind-public-assets",
    });
    expect(warnings).toHaveLength(0);
  });

  /** The whole point: an invented identifier is caught, not hoped away. */
  it("flags an ARN no tool returned", () => {
    const { citations, warnings } = validateCitations(
      `You should check ${FAKE}.`,
      new Set([ARN_A]),
      known,
    );
    expect(citations.find((c) => c.arn === FAKE)?.valid).toBe(false);
    expect(warnings[0]).toContain("no tool returned");
  });

  it("does not capture sentence punctuation as part of the ARN", () => {
    const { citations } = validateCitations(`Public: ${ARN_A}.`, new Set([ARN_A]), known);
    expect(citations[0]?.arn).toBe(ARN_A);
  });

  it("reports each ARN once however often it appears", () => {
    const { citations } = validateCitations(`${ARN_A} and again ${ARN_A}`, new Set([ARN_A]), known);
    expect(citations).toHaveLength(1);
  });

  it("resolves a bare resource name so the UI can highlight it", () => {
    const { citations } = validateCitations(
      "prod-web-1 is internet-facing.",
      new Set([ARN_B]),
      known,
    );
    expect(citations).toContainEqual({
      arn: ARN_B,
      valid: true,
      kind: "Ec2Instance",
      name: "prod-web-1",
    });
  });

  it("does not match a name that is only a prefix of a longer word", () => {
    const { citations } = validateCitations("prod-web-10 is fine.", new Set([ARN_B]), known);
    expect(citations).toHaveLength(0);
  });

  it("returns nothing for an answer that names no resources", () => {
    const { citations, warnings } = validateCitations("Nothing is public.", new Set(), known);
    expect(citations).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });
});

describe("CitationTracker", () => {
  it("harvests ARNs, names and kinds from nested rows", () => {
    const tracker = new CitationTracker();
    tracker.record([{ hops: [{ arn: ARN_B, name: "prod-web-1", kind: "Ec2Instance" }] }], [ARN_B]);
    expect(tracker.allowed.has(ARN_B)).toBe(true);
    expect(tracker.known.get(ARN_B)?.name).toBe("prod-web-1");
  });

  it("accumulates across several tool calls", () => {
    const tracker = new CitationTracker();
    tracker.record([{ arn: ARN_A, name: "a" }], [ARN_A]);
    tracker.record([{ arn: ARN_B, name: "b" }], [ARN_B]);
    expect(tracker.allowed.size).toBe(2);
  });

  it("keeps an earlier name when a later row omits it", () => {
    const tracker = new CitationTracker();
    tracker.record([{ arn: ARN_A, name: "northwind-public-assets", kind: "S3Bucket" }], [ARN_A]);
    tracker.record([{ arn: ARN_A }], [ARN_A]);
    expect(tracker.known.get(ARN_A)?.name).toBe("northwind-public-assets");
  });
});

/**
 * Regression tests for a false positive found by running the agent for real.
 *
 * The model writes Markdown, so ARNs arrive wrapped in backticks, bold markers
 * or parentheses. An earlier pattern captured the closing delimiter, producing
 * an identifier no tool had returned and warning the user that a correct answer
 * was unverified.
 */
describe("ARNs embedded in Markdown", () => {
  const ARN = "arn:aws:s3:::northwind-public-assets";
  const known = new Map([[ARN, { arn: ARN, name: "northwind-public-assets", kind: "S3Bucket" }]]);
  const expectClean = (text: string) => {
    const { citations, warnings } = validateCitations(text, new Set([ARN]), known);
    expect(citations.map((c) => c.arn)).toEqual([ARN]);
    expect(warnings).toEqual([]);
  };

  it("handles a backtick-wrapped ARN", () => expectClean(`The bucket \`${ARN}\` is public.`));

  it("handles the exact shape the agent produced", () =>
    expectClean(
      `- **northwind-public-assets** (\`${ARN}\`, us-east-1) — bucket policy allows \`*\``,
    ));

  it("handles bold, parenthesised, and end-of-sentence forms", () => {
    expectClean(`**${ARN}** is public.`);
    expectClean(`Public: (${ARN})`);
    expectClean(`Public: ${ARN}.`);
    expectClean(`Check ${ARN}; it is public.`);
    expectClean(`- ${ARN}\n- something else`);
  });

  it("handles a Markdown link", () => expectClean(`[the bucket](#${ARN}) is public`));

  it("still flags a genuinely invented ARN wrapped in backticks", () => {
    const { warnings } = validateCitations(
      "Check `arn:aws:s3:::does-not-exist`.",
      new Set([ARN]),
      known,
    );
    expect(warnings).toHaveLength(1);
  });

  it("keeps ARNs whose resource id contains slashes and dots", () => {
    const arn = "arn:aws:ec2:us-east-1:123456789012:instance/i-0abc.def";
    const { citations, warnings } = validateCitations(
      `Instance \`${arn}\` is exposed.`,
      new Set([arn]),
      new Map([[arn, { arn }]]),
    );
    expect(citations[0]?.arn).toBe(arn);
    expect(warnings).toEqual([]);
  });
});

/**
 * The colon case. An ARN's resource section can contain colons, so the pattern
 * must not treat one as a terminator - while a colon that is sentence
 * punctuation still has to be stripped.
 */
describe("ARNs whose resource section contains colons", () => {
  const RDS = "arn:aws:rds:us-east-1:123456789012:db:northwind-prod-db";

  it("keeps the whole RDS ARN rather than truncating at :db", () => {
    const { citations, warnings } = validateCitations(
      `**northwind-prod-db** (\`${RDS}\`) is reachable.`,
      new Set([RDS]),
      new Map([[RDS, { arn: RDS, name: "northwind-prod-db", kind: "RdsInstance" }]]),
    );
    expect(citations.map((c) => c.arn)).toEqual([RDS]);
    expect(warnings).toEqual([]);
  });

  it("handles other colon-bearing ARN shapes", () => {
    for (const arn of [
      "arn:aws:sns:us-east-1:123456789012:my-topic",
      "arn:aws:rds:eu-west-1:123456789012:subgrp:prod-db-subnets",
      "arn:aws:lambda:us-east-1:123456789012:function:order-processor",
      "arn:aws:states:us-east-1:123456789012:execution:machine:run-1",
    ]) {
      const { citations, warnings } = validateCitations(
        `See \`${arn}\` for detail.`,
        new Set([arn]),
        new Map([[arn, { arn }]]),
      );
      expect(citations[0]?.arn, arn).toBe(arn);
      expect(warnings, arn).toEqual([]);
    }
  });

  it("still strips a colon that is sentence punctuation", () => {
    const arn = "arn:aws:s3:::my-bucket";
    const { citations, warnings } = validateCitations(
      `Public buckets: ${arn}: check it.`,
      new Set([arn]),
      new Map([[arn, { arn }]]),
    );
    expect(citations[0]?.arn).toBe(arn);
    expect(warnings).toEqual([]);
  });
});
