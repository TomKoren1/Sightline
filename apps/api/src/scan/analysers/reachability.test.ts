import { describe, expect, it } from "vitest";
import { INTERNET_ARN, type Relationship, type Resource } from "@sightline/shared";
import { analyseReachability, transitiveFromInternet } from "./reachability.js";

/** Terse builders, so each test reads as a topology rather than as plumbing. */
const sg = (id: string, ingress: unknown[]): Resource => ({
  arn: `sg:${id}`,
  kind: "SecurityGroup",
  name: id,
  region: "us-east-1",
  accountId: "1",
  tags: {},
  properties: { groupId: id, ingress },
  derived: {},
});

const host = (name: string, _subnet: string): Resource => ({
  arn: `host:${name}`,
  kind: "Ec2Instance",
  name,
  region: "us-east-1",
  accountId: "1",
  tags: {},
  properties: {},
  derived: {},
});

const subnet = (name: string, isPublic: boolean): Resource => ({
  arn: `subnet:${name}`,
  kind: "Subnet",
  name,
  region: "us-east-1",
  accountId: "1",
  tags: {},
  properties: {},
  derived: { isPublic },
});

const open = (port: number) => ({
  protocol: "tcp",
  fromPort: port,
  toPort: port,
  source: "cidr",
  cidr: "0.0.0.0/0",
});
const fromSg = (port: number, groupId: string) => ({
  protocol: "tcp",
  fromPort: port,
  toPort: port,
  source: "securityGroup",
  groupId,
});

describe("analyseReachability", () => {
  it("links the internet to an exposed host whose group admits 0.0.0.0/0", () => {
    const resources = [subnet("public", true), sg("web", [open(443)]), host("web1", "public")];
    const relationships: Relationship[] = [
      { from: "host:web1", to: "sg:web", type: "HAS_SECURITY_GROUP" },
      { from: "host:web1", to: "subnet:public", type: "IN_SUBNET" },
    ];
    const { edges } = analyseReachability(resources, relationships);
    const edge = edges.find((e) => e.from === INTERNET_ARN && e.to === "host:web1");
    expect(edge).toBeDefined();
    expect(edge?.properties?.["ports"]).toBe("tcp/443");
    expect(edge?.properties?.["reason"]).toContain("public subnet");
  });

  /**
   * An open rule on something not actually exposed is a latent risk, not a
   * live path. Reporting it would bury the real findings in noise.
   */
  it("does not link the internet to a host in a private subnet, even with an open rule", () => {
    const resources = [subnet("private", false), sg("web", [open(443)]), host("app1", "private")];
    const relationships: Relationship[] = [
      { from: "host:app1", to: "sg:web", type: "HAS_SECURITY_GROUP" },
      { from: "host:app1", to: "subnet:private", type: "IN_SUBNET" },
    ];
    const { edges } = analyseReachability(resources, relationships);
    expect(edges.find((e) => e.from === INTERNET_ARN)).toBeUndefined();
  });

  it("links one host to another when the target's group admits the source's group", () => {
    const resources = [
      sg("web", []),
      sg("app", [fromSg(9000, "web")]),
      host("web1", "x"),
      host("app1", "x"),
    ];
    const relationships: Relationship[] = [
      { from: "host:web1", to: "sg:web", type: "HAS_SECURITY_GROUP" },
      { from: "host:app1", to: "sg:app", type: "HAS_SECURITY_GROUP" },
    ];
    const { edges } = analyseReachability(resources, relationships);
    const edge = edges.find((e) => e.from === "host:web1" && e.to === "host:app1");
    expect(edge).toBeDefined();
    expect(edge?.properties?.["reason"]).toContain("web1 belongs to");
  });

  it("walks a three-hop chain from the internet to a private database", () => {
    const resources = [
      subnet("public", true),
      subnet("private", false),
      sg("web", [open(443)]),
      sg("app", [fromSg(9000, "web")]),
      sg("db", [fromSg(5432, "app")]),
      host("web1", "public"),
      host("app1", "private"),
      host("db1", "private"),
    ];
    const relationships: Relationship[] = [
      { from: "host:web1", to: "sg:web", type: "HAS_SECURITY_GROUP" },
      { from: "host:web1", to: "subnet:public", type: "IN_SUBNET" },
      { from: "host:app1", to: "sg:app", type: "HAS_SECURITY_GROUP" },
      { from: "host:app1", to: "subnet:private", type: "IN_SUBNET" },
      { from: "host:db1", to: "sg:db", type: "HAS_SECURITY_GROUP" },
      { from: "host:db1", to: "subnet:private", type: "IN_SUBNET" },
    ];
    const { internetReachable } = analyseReachability(resources, relationships);
    expect(internetReachable.has("host:web1")).toBe(true);
    expect(internetReachable.has("host:app1")).toBe(true);
    expect(internetReachable.has("host:db1")).toBe(true);
  });

  it("does not reach a database whose group opens nothing, however it is flagged", () => {
    const publicDb: Resource = {
      ...host("analytics", "private"),
      kind: "RdsInstance",
      properties: { publiclyAccessible: true },
    };
    const resources = [subnet("private", false), sg("isolated", []), publicDb];
    const relationships: Relationship[] = [
      { from: publicDb.arn, to: "sg:isolated", type: "HAS_SECURITY_GROUP" },
    ];
    const { internetReachable } = analyseReachability(resources, relationships);
    expect(internetReachable.has(publicDb.arn)).toBe(false);
  });

  it("terminates on mutually-referencing security groups", () => {
    const edges: Relationship[] = [
      { from: INTERNET_ARN, to: "a", type: "CAN_REACH" },
      { from: "a", to: "b", type: "CAN_REACH" },
      { from: "b", to: "a", type: "CAN_REACH" },
    ];
    expect([...transitiveFromInternet(edges)].sort()).toEqual(["a", "b"]);
  });

  it("does not emit a self-edge for hosts sharing one group", () => {
    const resources = [sg("shared", [fromSg(80, "shared")]), host("h1", "x")];
    const relationships: Relationship[] = [
      { from: "host:h1", to: "sg:shared", type: "HAS_SECURITY_GROUP" },
    ];
    const { edges } = analyseReachability(resources, relationships);
    expect(edges.find((e) => e.from === "host:h1" && e.to === "host:h1")).toBeUndefined();
  });
});
