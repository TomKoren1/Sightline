import { describe, expect, it } from "vitest";
import type { Relationship, Resource } from "@sightline/shared";

import type { FlatRoute } from "../collectors/routes.js";
import { analyseReachability } from "./reachability.js";
import { hopsFrom, indexReach } from "./reachIndex.js";
import { cidrContains, parseCidr } from "./routing.js";

/** Builders that read as a network diagram. */
const res = (
  kind: Resource["kind"],
  arn: string,
  properties: Record<string, unknown>,
): Resource => ({
  arn,
  kind,
  name: arn.split(":").at(-1)!,
  region: "us-east-1",
  accountId: "1",
  tags: {},
  properties,
  derived: {},
});

const route = (
  destination: string,
  targetType: FlatRoute["targetType"],
  targetId: string | null = null,
  state = "active",
): FlatRoute => ({ destination, targetType, targetId, state });

/** A subnet with its own route table, which always has the VPC's local route. */
function subnet(
  name: string,
  vpcId: string,
  cidr: string,
  vpcCidr: string,
  routes: FlatRoute[] = [],
) {
  return [
    res("Subnet", `subnet:${name}`, { vpcId, cidrBlock: cidr, routeTableId: `rtb-${name}` }),
    res("RouteTable", `rtb:${name}`, {
      routeTableId: `rtb-${name}`,
      vpcId,
      routes: [route(vpcCidr, "local"), ...routes],
    }),
  ];
}

const sg = (id: string, ingress: unknown[]) =>
  res("SecurityGroup", `sg:${id}`, { groupId: id, ingress });
const cidrRule = (port: number, cidr: string) => ({
  protocol: "tcp",
  fromPort: port,
  toPort: port,
  source: "cidr",
  cidr,
});
const host = (name: string, ip?: string) =>
  res("Ec2Instance", `host:${name}`, ip ? { privateIpAddress: ip } : {});
const placed = (name: string, subnetName: string, group?: string): Relationship[] => [
  { from: `host:${name}`, to: `subnet:${subnetName}`, type: "IN_SUBNET" },
  ...(group
    ? [{ from: `host:${name}`, to: `sg:${group}`, type: "HAS_SECURITY_GROUP" as const }]
    : []),
];
const peering = (id: string, a: string, b: string, active = true) =>
  res("VpcPeeringConnection", `pcx:${id}`, {
    peeringId: id,
    active,
    requester: { vpcId: a },
    accepter: { vpcId: b },
  });

/** Whether `from` reaches the database, by walking the edges the analyser produced. */
function reaches(resources: Resource[], relationships: Relationship[], from: string) {
  const { edges } = analyseReachability(resources, relationships);
  const hops = hopsFrom(indexReach([...relationships, ...edges]), from);
  return { reached: hops.has("host:db"), edges: edges.filter((e) => e.to === "host:db") };
}

/** prod (10.0/16) holds the database; its group admits 5432 from `admit`. */
function prod(admit: string, prodRoutes: FlatRoute[] = []) {
  return {
    resources: [
      ...subnet("prod-data", "vpc-prod", "10.0.2.0/24", "10.0.0.0/16", prodRoutes),
      sg("db", [cidrRule(5432, admit)]),
      host("db"),
    ],
    relationships: placed("db", "prod-data", "db"),
  };
}

describe("CIDR arithmetic", () => {
  it("contains what is inside, and not what only overlaps", () => {
    expect(cidrContains(parseCidr("10.0.0.0/16")!, parseCidr("10.0.3.0/24")!)).toBe(true);
    expect(cidrContains(parseCidr("10.0.3.0/24")!, parseCidr("10.0.0.0/16")!)).toBe(false);
    expect(cidrContains(parseCidr("0.0.0.0/0")!, parseCidr("192.168.1.1")!)).toBe(true);
    expect(parseCidr("10.0.0.300/16")).toBeNull();
    expect(parseCidr("2001:db8::/32")).toBeNull();
  });
});

describe("private ranges, by the route tables", () => {
  it("lets a subnet inside the admitted range reach the target, inside one VPC", () => {
    const net = prod("10.0.0.0/16");
    const resources = [
      ...net.resources,
      ...subnet("prod-app", "vpc-prod", "10.0.1.0/24", "10.0.0.0/16"),
      host("app1"),
    ];
    const relationships = [...net.relationships, ...placed("app1", "prod-app")];
    const { reached, edges } = reaches(resources, relationships, "host:app1");
    expect(reached).toBe(true);
    const fromApp = edges.find((e) => e.from === "subnet:prod-app");
    expect(fromApp?.properties?.["reason"]).toMatch(
      /allows tcp\/5432 from 10\.0\.0\.0\/16, which covers subnet prod-app$/,
    );
  });

  it("follows an active peering with a route on both sides", () => {
    const net = prod("10.1.0.0/16", [route("10.1.0.0/16", "peering", "pcx-1")]);
    const resources = [
      ...net.resources,
      ...subnet("analytics", "vpc-analytics", "10.1.4.0/24", "10.1.0.0/16", [
        route("10.0.0.0/16", "peering", "pcx-1"),
      ]),
      peering("pcx-1", "vpc-analytics", "vpc-prod"),
      host("worker"),
    ];
    const { reached, edges } = reaches(
      resources,
      [...net.relationships, ...placed("worker", "analytics")],
      "host:worker",
    );
    expect(reached).toBe(true);
    expect(edges[0]?.properties?.["reason"]).toContain(
      "over peering pcx-1, with a route back over peering pcx-1",
    );
  });

  it("refuses a peering whose replies have no way back", () => {
    // The common way a peering "works" in the console and carries nothing.
    const net = prod("10.1.0.0/16");
    const resources = [
      ...net.resources,
      ...subnet("analytics", "vpc-analytics", "10.1.4.0/24", "10.1.0.0/16", [
        route("10.0.0.0/16", "peering", "pcx-1"),
      ]),
      peering("pcx-1", "vpc-analytics", "vpc-prod"),
      host("worker"),
    ];
    expect(
      reaches(resources, [...net.relationships, ...placed("worker", "analytics")], "host:worker")
        .reached,
    ).toBe(false);
  });

  it("refuses a peering that is not active, routes or not", () => {
    const net = prod("10.1.0.0/16", [route("10.1.0.0/16", "peering", "pcx-1")]);
    const resources = [
      ...net.resources,
      ...subnet("analytics", "vpc-analytics", "10.1.4.0/24", "10.1.0.0/16", [
        route("10.0.0.0/16", "peering", "pcx-1"),
      ]),
      peering("pcx-1", "vpc-analytics", "vpc-prod", false),
      host("worker"),
    ];
    expect(
      reaches(resources, [...net.relationships, ...placed("worker", "analytics")], "host:worker")
        .reached,
    ).toBe(false);
  });

  it("lets a more specific blackhole win over a broader working route", () => {
    const net = prod("10.1.0.0/16", [route("10.1.0.0/16", "peering", "pcx-1")]);
    const resources = [
      ...net.resources,
      ...subnet("analytics", "vpc-analytics", "10.1.4.0/24", "10.1.0.0/16", [
        route("10.0.0.0/16", "peering", "pcx-1"),
        route("10.0.2.0/24", "nat-gateway", "nat-gone", "blackhole"),
      ]),
      peering("pcx-1", "vpc-analytics", "vpc-prod"),
      host("worker"),
    ];
    expect(
      reaches(resources, [...net.relationships, ...placed("worker", "analytics")], "host:worker")
        .reached,
    ).toBe(false);
  });

  it("ignores a VPC with an overlapping range that nothing connects", () => {
    const net = prod("10.1.0.0/16");
    const resources = [
      ...net.resources,
      ...subnet("elsewhere", "vpc-other", "10.1.4.0/24", "10.1.0.0/16"),
      host("stranger"),
    ];
    expect(
      reaches(
        resources,
        [...net.relationships, ...placed("stranger", "elsewhere")],
        "host:stranger",
      ).reached,
    ).toBe(false);
  });

  it("names the hosts, not the subnet, when the range covers only part of it", () => {
    const net = prod("10.0.1.0/28");
    const resources = [
      ...net.resources,
      ...subnet("prod-app", "vpc-prod", "10.0.1.0/24", "10.0.0.0/16"),
      host("inside", "10.0.1.5"),
      host("outside", "10.0.1.200"),
    ];
    const relationships = [
      ...net.relationships,
      ...placed("inside", "prod-app"),
      ...placed("outside", "prod-app"),
    ];
    const { edges } = reaches(resources, relationships, "host:inside");
    expect(edges.map((e) => e.from)).toEqual(["host:inside"]);
    expect(reaches(resources, relationships, "host:outside").reached).toBe(false);
  });
});

describe("transit gateways", () => {
  const tgw = (tableRoutes: { destination: string; attachmentIds: string[]; state: string }[]) =>
    res("TransitGateway", "tgw:hub", {
      transitGatewayId: "tgw-1",
      attachments: [
        {
          attachmentId: "att-prod",
          vpcId: "vpc-prod",
          state: "available",
          routeTableId: "tgw-rtb-1",
        },
        {
          attachmentId: "att-shared",
          vpcId: "vpc-shared",
          state: "available",
          routeTableId: "tgw-rtb-1",
        },
      ],
      routeTables: [{ routeTableId: "tgw-rtb-1", routes: tableRoutes }],
    });
  const world = (tableRoutes: Parameters<typeof tgw>[0]) => {
    const net = prod("10.3.0.0/16", [route("10.3.0.0/16", "transit-gateway", "tgw-1")]);
    return {
      resources: [
        ...net.resources,
        ...subnet("ci", "vpc-shared", "10.3.1.0/24", "10.3.0.0/16", [
          route("10.0.0.0/16", "transit-gateway", "tgw-1"),
        ]),
        tgw(tableRoutes),
        host("runner"),
      ],
      relationships: [...net.relationships, ...placed("runner", "ci")],
    };
  };

  it("crosses when the TGW's own table routes each way to the other attachment", () => {
    const { resources, relationships } = world([
      { destination: "10.0.0.0/16", attachmentIds: ["att-prod"], state: "active" },
      { destination: "10.3.0.0/16", attachmentIds: ["att-shared"], state: "active" },
    ]);
    const { reached, edges } = reaches(resources, relationships, "host:runner");
    expect(reached).toBe(true);
    expect(edges[0]?.properties?.["reason"]).toContain("over transit gateway hub");
  });

  it("stops when the TGW's table has no route for the destination", () => {
    const { resources, relationships } = world([
      { destination: "10.3.0.0/16", attachmentIds: ["att-shared"], state: "active" },
    ]);
    expect(reaches(resources, relationships, "host:runner").reached).toBe(false);
  });

  it("stops when the TGW route sends the traffic to some other attachment", () => {
    const { resources, relationships } = world([
      { destination: "10.0.0.0/16", attachmentIds: ["att-vpn"], state: "active" },
      { destination: "10.3.0.0/16", attachmentIds: ["att-shared"], state: "active" },
    ]);
    expect(reaches(resources, relationships, "host:runner").reached).toBe(false);
  });

  it("accepts a route that names no attachment, as moto reports them", () => {
    const { resources, relationships } = world([
      { destination: "10.0.0.0/8", attachmentIds: [], state: "active" },
    ]);
    expect(reaches(resources, relationships, "host:runner").reached).toBe(true);
  });
});

describe("PrivateLink", () => {
  it("joins an interface endpoint to the load balancer behind its service", () => {
    const resources = [
      res("VpcEndpoint", "vpce:orders", { state: "available" }),
      res("VpcEndpointService", "svc:orders", { state: "Available" }),
      res("LoadBalancer", "lb:orders-nlb", {}),
    ];
    const relationships: Relationship[] = [
      { from: "vpce:orders", to: "svc:orders", type: "CONNECTS_TO" },
      { from: "svc:orders", to: "lb:orders-nlb", type: "SERVED_BY" },
    ];
    const { edges } = analyseReachability(resources, relationships);
    const edge = edges.find((e) => e.from === "vpce:orders" && e.to === "lb:orders-nlb");
    expect(edge?.properties?.["reason"]).toContain("through PrivateLink service orders");
  });

  it("does not join an endpoint the provider has not accepted", () => {
    const resources = [
      res("VpcEndpoint", "vpce:orders", { state: "pendingAcceptance" }),
      res("LoadBalancer", "lb:orders-nlb", {}),
      res("VpcEndpointService", "svc:orders", {}),
    ];
    const relationships: Relationship[] = [
      { from: "vpce:orders", to: "svc:orders", type: "CONNECTS_TO" },
      { from: "svc:orders", to: "lb:orders-nlb", type: "SERVED_BY" },
    ];
    expect(analyseReachability(resources, relationships).edges).toEqual([]);
  });
});
