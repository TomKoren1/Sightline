/**
 * Network topology: VPCs, subnets, routing, gateways and security groups.
 *
 * This collector produces the structure that every reachability question is
 * later answered from, so it is deliberately thorough about two things:
 *
 *  - **Route tables.** A subnet is public if its associated route table sends
 *    `0.0.0.0/0` to an internet gateway. Not if it is tagged "public". The
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
  type RouteTable,
} from "@aws-sdk/client-ec2";
import type { Relationship, Resource } from "@daveio/shared";

import { ec2Client } from "../../aws/clients.js";
import { ec2Arn, nameFromTags, regionArn, tagsToRecord } from "../../aws/arns.js";
import type { CollectorContext, CollectorOutput } from "./types.js";

export async function collectVpc(ctx: CollectorContext): Promise<CollectorOutput> {
  const region = ctx.region!;
  const client = ec2Client(region);
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
  /** Gateway id -> the VPC it is attached to, used to classify route tables. */
  const igwToVpc = new Map<string, string>();
  for await (const page of paginateDescribeInternetGateways({ client }, {})) {
    for (const igw of page.InternetGateways ?? []) {
      if (!igw.InternetGatewayId) continue;
      const tags = tagsToRecord(igw.Tags);
      const arn = ec2Arn(region, ctx.accountId, "internet-gateway", igw.InternetGatewayId);
      const attachedVpc = igw.Attachments?.[0]?.VpcId;
      if (attachedVpc) igwToVpc.set(igw.InternetGatewayId, attachedVpc);
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
  // decided by the route table associated with it.
  const routeTables: RouteTable[] = [];
  for await (const page of paginateDescribeRouteTables({ client }, {})) {
    routeTables.push(...(page.RouteTables ?? []));
  }

  /** Subnet id -> the internet gateway that gives it a default route, if any. */
  const subnetToIgw = new Map<string, string>();
  for (const rt of routeTables) {
    if (!rt.RouteTableId) continue;
    const tags = tagsToRecord(rt.Tags);
    const arn = ec2Arn(region, ctx.accountId, "route-table", rt.RouteTableId);
    const defaultRoute = (rt.Routes ?? []).find(
      (r) => r.DestinationCidrBlock === "0.0.0.0/0" && r.GatewayId?.startsWith("igw-"),
    );

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
        hasInternetRoute: Boolean(defaultRoute),
        internetGatewayId: defaultRoute?.GatewayId ?? null,
        routeCount: (rt.Routes ?? []).length,
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
    if (defaultRoute?.GatewayId) {
      relationships.push({
        from: arn,
        to: ec2Arn(region, ctx.accountId, "internet-gateway", defaultRoute.GatewayId),
        type: "ROUTES_TO",
        properties: { destination: "0.0.0.0/0" },
      });
    }

    for (const assoc of rt.Associations ?? []) {
      if (assoc.SubnetId && defaultRoute?.GatewayId) {
        subnetToIgw.set(assoc.SubnetId, defaultRoute.GatewayId);
      }
    }
  }
  void igwToVpc;

  // --- Subnets ------------------------------------------------------------
  for await (const page of paginateDescribeSubnets({ client }, {})) {
    for (const subnet of page.Subnets ?? []) {
      if (!subnet.SubnetId) continue;
      const tags = tagsToRecord(subnet.Tags);
      const arn = ec2Arn(region, ctx.accountId, "subnet", subnet.SubnetId);
      const igw = subnetToIgw.get(subnet.SubnetId);
      // Auto-assigned public IPs make a subnet effectively public too, but
      // only routing makes it reachable, so routing is the primary signal.
      const isPublic = Boolean(igw);

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
          isPublic,
        },
        derived: {
          isPublic,
          publicReason: isPublic
            ? `Its route table sends 0.0.0.0/0 to internet gateway ${igw}`
            : "No route table associated with this subnet has a default route to an internet gateway",
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

  return { resources, relationships };
}
