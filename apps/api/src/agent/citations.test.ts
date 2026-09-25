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
