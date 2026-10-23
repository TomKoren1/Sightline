/**
 * Network topology: VPCs, subnets, routing, gateways and security groups.
 *
 * This collector produces the structure that every reachability question is
 * later answered from, so it is deliberately thorough about two things:
 *
 *  - **Route tables.** A subnet is public if the route table it uses - its
 *    own, or its VPC's main one - sends `0.0.0.0/0` to an internet gateway.
 *    Not if it is tagged "public". The
 *    `isPublic` fact recorded here is derived from routing, and the reason
 *    names the gateway that justified it.
 *
 *  - **Security group rule sources.** A rule can admit a CIDR or another
 *    security group. Both are captured, because the second kind is what turns
 *    a flat list of groups into a graph you can walk.
 */

import {
  paginateDescribeVpcs,
  paginateDescribeSubnets,
  paginateDescribeRouteTables,
  paginateDescribeInternetGateways,
  paginateDescribeNatGateways,
  paginateDescribeSecurityGroups,
  paginateDescribeNetworkAcls,
  type RouteTable,
} from "@aws-sdk/client-ec2";
import type { Relationship, Resource } from "@sightline/shared";

import { ec2Client } from "../../aws/clients.js";
import { ec2Arn, nameFromTags, regionArn, tagsToRecord } from "../../aws/arns.js";
import { collectConnectivity } from "./connectivity.js";
import { flattenRoute, internetRoute } from "./routes.js";
import type { CollectorContext, CollectorOutput } from "./types.js";

export async function collectVpc(ctx: CollectorContext): Promise<CollectorOutput> {
  const region = ctx.region!;
  const client = ec2Client(ctx, region);
  const resources: Resource[] = [];
  const relationships: Relationship[] = [];
  const inRegion = (arn: string): Relationship => ({
    from: arn,
    to: regionArn(ctx.accountId, region),
    type: "IN_REGION",
  });

  // --- VPCs ---------------------------------------------------------------
  for await (const page of paginateDescribeVpcs({ client }, {})) {
    for (const vpc of page.Vpcs ?? []) {
      if (!vpc.VpcId) continue;
      const tags = tagsToRecord(vpc.Tags);
      const arn = ec2Arn(region, ctx.accountId, "vpc", vpc.VpcId);
      resources.push({
        arn,
        kind: "Vpc",
        name: nameFromTags(tags, vpc.VpcId),
        region,
        accountId: ctx.accountId,
        tags,
        properties: {
          vpcId: vpc.VpcId,
          cidrBlock: vpc.CidrBlock,
          isDefault: vpc.IsDefault ?? false,
          state: vpc.State,
        },
        derived: {},
        raw: vpc,
      });
      relationships.push(inRegion(arn));
    }
  }

  // --- Internet gateways --------------------------------------------------
  for await (const page of paginateDescribeInternetGateways({ client }, {})) {
    for (const igw of page.InternetGateways ?? []) {
      if (!igw.InternetGatewayId) continue;
      const tags = tagsToRecord(igw.Tags);
      const arn = ec2Arn(region, ctx.accountId, "internet-gateway", igw.InternetGatewayId);
      const attachedVpc = igw.Attachments?.[0]?.VpcId;
      resources.push({
        arn,
        kind: "InternetGateway",
        name: nameFromTags(tags, igw.InternetGatewayId),
        region,
        accountId: ctx.accountId,
        tags,
        properties: {
          internetGatewayId: igw.InternetGatewayId,
          attachedVpcId: attachedVpc ?? null,
        },
        derived: {},
        raw: igw,
      });
      relationships.push(inRegion(arn));
      if (attachedVpc) {
        relationships.push({
          from: arn,
          to: ec2Arn(region, ctx.accountId, "vpc", attachedVpc),
          type: "ATTACHED_TO",
        });
      }
    }
  }

  // --- NAT gateways -------------------------------------------------------
  for await (const page of paginateDescribeNatGateways({ client }, {})) {
    for (const nat of page.NatGateways ?? []) {
      if (!nat.NatGatewayId) continue;
      const tags = tagsToRecord(nat.Tags);
      const arn = ec2Arn(region, ctx.accountId, "natgateway", nat.NatGatewayId);
      resources.push({
        arn,
        kind: "NatGateway",
        name: nameFromTags(tags, nat.NatGatewayId),
        region,
        accountId: ctx.accountId,
        tags,
        properties: {
          natGatewayId: nat.NatGatewayId,
          subnetId: nat.SubnetId,
          vpcId: nat.VpcId,
          state: nat.State,
          createdAt: nat.CreateTime?.toISOString() ?? null,
        },
        derived: {},
        raw: nat,
      });
      relationships.push(inRegion(arn));
      if (nat.SubnetId) {
        relationships.push({
          from: arn,
          to: ec2Arn(region, ctx.accountId, "subnet", nat.SubnetId),
          type: "IN_SUBNET",
        });
      }
    }
  }

  // --- Route tables -------------------------------------------------------
  // Collected before subnets, because a subnet's public/private verdict is
  // decided by the route table it uses: its own association, or else its
  // VPC's main table - which AWS applies silently and is easy to forget.
  const routeTables: RouteTable[] = [];
  for await (const page of paginateDescribeRouteTables({ client }, {})) {
    routeTables.push(...(page.RouteTables ?? []));
  }

  const explicitTable = new Map<string, RouteTable>();
  const mainTable = new Map<string, RouteTable>();
  for (const rt of routeTables) {
    for (const assoc of rt.Associations ?? []) {
      if (assoc.Main && rt.VpcId) mainTable.set(rt.VpcId, rt);
      if (assoc.SubnetId) explicitTable.set(assoc.SubnetId, rt);
    }
  }

  for (const rt of routeTables) {
    if (!rt.RouteTableId) continue;
    const tags = tagsToRecord(rt.Tags);
    const arn = ec2Arn(region, ctx.accountId, "route-table", rt.RouteTableId);
    const routes = (rt.Routes ?? []).map(flattenRoute);
    const internet = internetRoute(routes);

    resources.push({
      arn,
      kind: "RouteTable",
      name: nameFromTags(tags, rt.RouteTableId),
      region,
      accountId: ctx.accountId,
      tags,
      properties: {
        routeTableId: rt.RouteTableId,
        vpcId: rt.VpcId,
        isMain: (rt.Associations ?? []).some((a) => a.Main),
        hasInternetRoute: Boolean(internet),
        internetGatewayId: internet?.targetId ?? null,
        routeCount: routes.length,
        routes,
      },
      derived: {},
      raw: rt,
    });
    relationships.push(inRegion(arn));
    if (rt.VpcId) {
      relationships.push({
        from: arn,
        to: ec2Arn(region, ctx.accountId, "vpc", rt.VpcId),
        type: "IN_VPC",
      });
    }
    if (internet?.targetId) {
      relationships.push({
        from: arn,
        to: ec2Arn(region, ctx.accountId, "internet-gateway", internet.targetId),
        type: "ROUTES_TO",
        properties: { destination: internet.destination },
      });
    }
  }

  // --- Subnets ------------------------------------------------------------
  for await (const page of paginateDescribeSubnets({ client }, {})) {
    for (const subnet of page.Subnets ?? []) {
      if (!subnet.SubnetId) continue;
      const tags = tagsToRecord(subnet.Tags);
      const arn = ec2Arn(region, ctx.accountId, "subnet", subnet.SubnetId);
      const explicit = explicitTable.get(subnet.SubnetId);
      const table = explicit ?? (subnet.VpcId ? mainTable.get(subnet.VpcId) : undefined);
      const igw = table ? internetRoute((table.Routes ?? []).map(flattenRoute))?.targetId : null;
      // Auto-assigned public IPs make a subnet effectively public too, but
      // only routing makes it reachable, so routing is the primary signal.
      const isPublic = Boolean(igw);
      const which = explicit
        ? "Its route table"
        : "Its VPC's main route table, which it uses by default,";

      resources.push({
        arn,
        kind: "Subnet",
        name: nameFromTags(tags, subnet.SubnetId),
        region,
        accountId: ctx.accountId,
        tags,
        properties: {
          subnetId: subnet.SubnetId,
          vpcId: subnet.VpcId,
          cidrBlock: subnet.CidrBlock,
          availabilityZone: subnet.AvailabilityZone,
          mapPublicIpOnLaunch: subnet.MapPublicIpOnLaunch ?? false,
          routeTableId: table?.RouteTableId ?? null,
          isPublic,
        },
        derived: {
          isPublic,
          publicReason: isPublic
            ? `${which} sends 0.0.0.0/0 to internet gateway ${igw}`
            : "The route table this subnet uses has no active default route to an internet gateway",
        },
        raw: subnet,
      });
      relationships.push(inRegion(arn));
      if (subnet.VpcId) {
        relationships.push({
          from: arn,
          to: ec2Arn(region, ctx.accountId, "vpc", subnet.VpcId),
          type: "IN_VPC",
        });
      }
      if (table?.RouteTableId) {
        relationships.push({
          from: arn,
          to: ec2Arn(region, ctx.accountId, "route-table", table.RouteTableId),
          type: "USES_ROUTE_TABLE",
          properties: { main: !explicit },
        });
      }
    }
  }

  // --- Security groups ----------------------------------------------------
  for await (const page of paginateDescribeSecurityGroups({ client }, {})) {
    for (const sg of page.SecurityGroups ?? []) {
      if (!sg.GroupId) continue;
      const tags = tagsToRecord(sg.Tags);
      const arn = ec2Arn(region, ctx.accountId, "security-group", sg.GroupId);

      // Flatten ingress rules into a shape the reachability analyser can walk
      // without re-parsing the AWS wire format.
      const ingress = (sg.IpPermissions ?? []).flatMap((perm) => {
        const range = {
          protocol: perm.IpProtocol ?? "-1",
          fromPort: perm.FromPort ?? null,
          toPort: perm.ToPort ?? null,
        };
        const fromCidrs = (perm.IpRanges ?? []).map((r) => ({
          ...range,
          source: "cidr" as const,
          cidr: r.CidrIp ?? "",
          description: r.Description ?? null,
        }));
        const fromGroups = (perm.UserIdGroupPairs ?? []).map((g) => ({
          ...range,
          source: "securityGroup" as const,
          groupId: g.GroupId ?? "",
          description: g.Description ?? null,
        }));
        return [...fromCidrs, ...fromGroups];
      });

      resources.push({
        arn,
        kind: "SecurityGroup",
        name: sg.GroupName ?? nameFromTags(tags, sg.GroupId),
        region,
        accountId: ctx.accountId,
        tags,
        properties: {
          groupId: sg.GroupId,
          groupName: sg.GroupName,
          description: sg.Description,
          vpcId: sg.VpcId,
          ingress,
          ingressRuleCount: ingress.length,
        },
        derived: {},
        raw: sg,
      });
      relationships.push(inRegion(arn));
      if (sg.VpcId) {
        relationships.push({
          from: arn,
          to: ec2Arn(region, ctx.accountId, "vpc", sg.VpcId),
          type: "IN_VPC",
        });
      }
    }
  }

  // --- Network ACLs -------------------------------------------------------
  // Stateless and evaluated per subnet, lowest rule number first. A security
  // group can admit traffic its subnet's ACL then drops, which is why the
  // reachability analyser checks both before calling anything exposed.
  for await (const page of paginateDescribeNetworkAcls({ client }, {})) {
    for (const acl of page.NetworkAcls ?? []) {
      if (!acl.NetworkAclId) continue;
      const tags = tagsToRecord(acl.Tags);
      const arn = ec2Arn(region, ctx.accountId, "network-acl", acl.NetworkAclId);
      resources.push({
        arn,
        kind: "NetworkAcl",
        name: nameFromTags(tags, acl.NetworkAclId),
        region,
        accountId: ctx.accountId,
        tags,
        properties: {
          networkAclId: acl.NetworkAclId,
          vpcId: acl.VpcId ?? null,
          isDefault: acl.IsDefault ?? false,
          entries: (acl.Entries ?? []).map((e) => ({
            ruleNumber: e.RuleNumber ?? null,
            egress: e.Egress ?? false,
            action: e.RuleAction ?? null,
            protocol: e.Protocol ?? null,
            cidr: e.CidrBlock ?? e.Ipv6CidrBlock ?? null,
            fromPort: e.PortRange?.From ?? null,
            toPort: e.PortRange?.To ?? null,
          })),
        },
        derived: {},
        raw: acl,
      });
      relationships.push(inRegion(arn));
      for (const assoc of acl.Associations ?? []) {
        if (!assoc.SubnetId) continue;
        relationships.push({
          from: ec2Arn(region, ctx.accountId, "subnet", assoc.SubnetId),
          to: arn,
          type: "HAS_NACL",
        });
      }
    }
  }

  // Peering, transit gateways and PrivateLink: read against the routes above.
  const connectivity = await collectConnectivity(ctx, client);
  resources.push(...connectivity.resources);
  relationships.push(...connectivity.relationships);

  return { resources, relationships };
}
