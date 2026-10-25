import { describe, expect, it } from "vitest";
import type { Relationship, Resource } from "@sightline/shared";

import { replicateEstate } from "./replicate.js";

const resource = (arn: string, kind: Resource["kind"], properties = {}): Resource => ({
  arn,
  kind,
  name: arn.split("/").pop()!,
  region: "us-east-1",
  accountId: "123456789012",
  tags: {},
  properties,
  derived: {},
});

const SG = "arn:aws:ec2:us-east-1:123456789012:security-group/sg-0123456789abcdef0";
const HOST = "arn:aws:ec2:us-east-1:123456789012:instance/i-0123456789abcdef0";
const ROLE = "arn:aws:iam::123456789012:role/app";

const base = {
  resources: [
    resource(SG, "SecurityGroup", { groupId: "sg-0123456789abcdef0" }),
    resource(HOST, "Ec2Instance", { securityGroupIds: ["sg-0123456789abcdef0"] }),
    resource(ROLE, "IamRole"),
  ],
  relationships: [
    { from: HOST, to: SG, type: "HAS_SECURITY_GROUP" },
    { from: HOST, to: ROLE, type: "EXECUTES_AS" },
  ] as Relationship[],
};

describe("replicateEstate", () => {
  it("makes distinct copies that reference only themselves", () => {
    const out = replicateEstate(base, { copies: 3 });
    const arns = out.resources.map((r) => r.arn);
    expect(new Set(arns).size).toBe(9);

    const known = new Set(arns);
    for (const edge of out.relationships) {
      expect(known.has(edge.from) && known.has(edge.to)).toBe(true);
    }
    // A copy's instance names its own copy's group, in its edges and its properties.
    const host = out.resources.find((r) => r.kind === "Ec2Instance" && r.arn !== HOST)!;
    const edge = out.relationships.find(
      (e) => e.from === host.arn && e.type === "HAS_SECURITY_GROUP",
    )!;
    const group = out.resources.find((r) => r.arn === edge.to)!;
    expect(group.arn).not.toBe(SG);
    expect(host.properties["securityGroupIds"]).toEqual([group.properties["groupId"]]);
  });

  it("rewrites an ARN with no id in it, rather than leaving copies colliding", () => {
    const roles = replicateEstate(base, { copies: 2 }).resources.filter(
      (r) => r.kind === "IamRole",
    );
    expect(roles.map((r) => r.arn)).toEqual([
      ROLE,
      expect.stringMatching(/^arn:aws:iam::123456789012:role\/app-c/),
    ]);
  });

  it("crowds new instances into the original group, not new ones", () => {
    const out = replicateEstate(base, { copies: 1, crowd: 50 });
    const hosts = out.resources.filter((r) => r.kind === "Ec2Instance");
    expect(new Set(hosts.map((h) => h.arn)).size).toBe(51);
    const intoSg = out.relationships.filter((e) => e.type === "HAS_SECURITY_GROUP" && e.to === SG);
    expect(intoSg).toHaveLength(51);
    expect(out.resources.filter((r) => r.kind === "SecurityGroup")).toHaveLength(1);
  });
});
