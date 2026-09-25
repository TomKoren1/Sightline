/**
 * The adapter between the graph's flattened properties and the generators.
 *
 * Worth its own tests because the failure is quiet: if a JSON string is not
 * parsed back, the generator sees a string where it expects an array, finds no
 * ingress rules or no attached policies, and returns no remediation at all.
 * A finding would simply have nothing to suggest, and nothing would error.
 */

import { describe, expect, it } from "vitest";

import { remediationInputFromGraph } from "./fromGraph.js";
import { remediationsFor } from "./remediation.js";

describe("remediationInputFromGraph", () => {
  it("parses nested properties back from their JSON strings", () => {
    const input = remediationInputFromGraph({
      arn: "arn:aws:ec2:us-east-1:123456789012:security-group/sg-1",
      kind: "SecurityGroup",
      name: "bastion-sg",
      region: "us-east-1",
      props: {
        groupId: "sg-1",
        ingress: JSON.stringify([
          { protocol: "tcp", fromPort: 22, toPort: 22, source: "cidr", cidr: "0.0.0.0/0" },
        ]),
      },
    });

    expect(Array.isArray(input.properties["ingress"])).toBe(true);
    // And the round trip actually produces a remediation.
    expect(remediationsFor(input)).toHaveLength(1);
  });

  it("promotes derived facts from the flattened node", () => {
    const input = remediationInputFromGraph({
      arn: "arn:aws:s3:::b",
      kind: "S3Bucket",
      name: "b",
      region: null,
      props: { isPublic: true, publicReason: "wildcard policy", estimatedMonthlyCostUsd: 4 },
    });
    expect(input.derived.isPublic).toBe(true);
    expect(input.derived.publicReason).toBe("wildcard policy");
    expect(input.derived.estimatedMonthlyCostUsd).toBe(4);
  });

  it("leaves plain strings alone", () => {
    const input = remediationInputFromGraph({
      arn: "a",
      kind: "S3Bucket",
      name: "b",
      region: null,
      props: { publicAccessBlock: "not json at all" },
    });
    expect(input.properties["publicAccessBlock"]).toBe("not json at all");
  });

  it("drops a malformed structured property rather than throwing", () => {
    const input = remediationInputFromGraph({
      arn: "a",
      kind: "S3Bucket",
      name: "b",
      region: null,
      props: { isUnprotected: true, publicAccessBlock: "{ this is not json" },
    });
    expect(input.properties["publicAccessBlock"]).toBeUndefined();
    // Degrades to no remediation rather than a 500.
    expect(() => remediationsFor(input)).not.toThrow();
  });

  /** Only edges that mean "in use" should size the caution. */
  it("counts usage edges and ignores structural ones", () => {
    const input = remediationInputFromGraph({
      arn: "arn:aws:iam::123456789012:role/R",
      kind: "IamRole",
      name: "R",
      region: null,
      props: { isAdmin: true },
      incoming: [
        { type: "EXECUTES_AS", arn: "l", name: "legacy-image-resizer", kind: "LambdaFunction" },
        { type: "IN_REGION", arn: "r", name: "us-east-1", kind: "Region" },
      ],
    });
    expect(input.usedBy).toEqual([{ name: "legacy-image-resizer", kind: "LambdaFunction" }]);
  });

  it("omits usedBy entirely when nothing uses the resource", () => {
    const input = remediationInputFromGraph({
      arn: "a",
      kind: "IamRole",
      name: "R",
      region: null,
      props: {},
      incoming: [{ type: "IN_REGION", arn: "r", name: "us-east-1", kind: "Region" }],
    });
    expect(input.usedBy).toBeUndefined();
  });

  it("survives a row with no props at all", () => {
    const input = remediationInputFromGraph({
      arn: "a",
      kind: "S3Bucket",
      name: "b",
      region: null,
    });
    expect(remediationsFor(input)).toEqual([]);
  });
});
