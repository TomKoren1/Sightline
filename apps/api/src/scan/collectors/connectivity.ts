/**
 * How VPCs reach each other: peering, transit gateways, and PrivateLink.
 *
 * Collected so the reachability analyser can follow traffic out of one VPC and
 * into another - and refuse to when a route is missing in either direction,
 * which is the common way a peering "works" in the console and carries nothing.
 * Part of the VPC unit, since every fact here is read against its routes.
 */

import {
  paginateDescribeTransitGatewayAttachments,
  paginateDescribeTransitGatewayRouteTables,
  paginateDescribeTransitGateways,
  paginateDescribeVpcEndpoints,
  paginateDescribeVpcEndpointServiceConfigurations,
  paginateDescribeVpcPeeringConnections,
  SearchTransitGatewayRoutesCommand,
  type EC2Client,
} from "@aws-sdk/client-ec2";
import type { Relationship, Resource } from "@sightline/shared";

import { ec2Arn, nameFromTags, regionArn, tagsToRecord } from "../../aws/arns.js";
import type { CollectorContext, CollectorOutput } from "./types.js";

/** A transit gateway's attachment, as the analyser needs it. */
export interface TgwAttachment {
  attachmentId: string;
  resourceType: string | null;
  /** The VPC, when it is a VPC attachment. */
  vpcId: string | null;
  state: string | null;
  /** The TGW route table that decides where traffic arriving from it goes. */
  routeTableId: string | null;
}

export interface TgwRoute {
  destination: string | null;
  /** Empty where the API did not say; moto, for one, never does. */
  attachmentIds: string[];
  state: string | null;
}

const REFUSED = new Set(["UnauthorizedOperation", "AccessDenied", "AccessDeniedException"]);

export async function collectConnectivity(
  ctx: CollectorContext,
  client: EC2Client,
): Promise<CollectorOutput> {
  const region = ctx.region!;
  const resources: Resource[] = [];
  const relationships: Relationship[] = [];
  const add = (resource: Resource) => {
    resources.push(resource);
    relationships.push({
      from: resource.arn,
      to: regionArn(ctx.accountId, region),
      type: "IN_REGION",
    });
  };
  const vpcArn = (vpcId: string, account = ctx.accountId, inRegion = region) =>
    ec2Arn(inRegion, account, "vpc", vpcId);

  // --- Peering ------------------------------------------------------------
  for await (const page of paginateDescribeVpcPeeringConnections({ client }, {})) {
    for (const pcx of page.VpcPeeringConnections ?? []) {
      if (!pcx.VpcPeeringConnectionId) continue;
      const tags = tagsToRecord(pcx.Tags);
      const arn = ec2Arn(
        region,
        ctx.accountId,
        "vpc-peering-connection",
        pcx.VpcPeeringConnectionId,
      );
      const side = (s: typeof pcx.RequesterVpcInfo) => ({
        vpcId: s?.VpcId ?? null,
        ownerId: s?.OwnerId ?? null,
        region: s?.Region ?? region,
        cidr: s?.CidrBlock ?? null,
      });
      const requester = side(pcx.RequesterVpcInfo);
      const accepter = side(pcx.AccepterVpcInfo);
      const status = pcx.Status?.Code ?? null;
      add({
        arn,
        kind: "VpcPeeringConnection",
        name: nameFromTags(tags, pcx.VpcPeeringConnectionId),
        region,
        accountId: ctx.accountId,
        tags,
        properties: {
          peeringId: pcx.VpcPeeringConnectionId,
          status,
          active: status === "active",
          requester,
          accepter,
        },
        derived: {},
        raw: pcx,
      });
      for (const s of [requester, accepter]) {
        if (!s.vpcId) continue;
        relationships.push({
          from: arn,
          to: vpcArn(s.vpcId, s.ownerId ?? ctx.accountId, s.region),
          type: "PEERS_WITH",
        });
      }
    }
  }

  // --- Transit gateways ---------------------------------------------------
  const attachments = new Map<string, TgwAttachment[]>();
  for await (const page of paginateDescribeTransitGatewayAttachments({ client }, {})) {
    for (const a of page.TransitGatewayAttachments ?? []) {
      if (!a.TransitGatewayId || !a.TransitGatewayAttachmentId) continue;
      const list = attachments.get(a.TransitGatewayId) ?? [];
      list.push({
        attachmentId: a.TransitGatewayAttachmentId,
        resourceType: a.ResourceType ?? null,
        vpcId: a.ResourceType === "vpc" ? (a.ResourceId ?? null) : null,
        state: a.State ?? null,
        routeTableId: a.Association?.TransitGatewayRouteTableId ?? null,
      });
      attachments.set(a.TransitGatewayId, list);
    }
  }

  const tablesOf = new Map<string, { routeTableId: string; routes: TgwRoute[] }[]>();
  for await (const page of paginateDescribeTransitGatewayRouteTables({ client }, {})) {
    for (const table of page.TransitGatewayRouteTables ?? []) {
      if (!table.TransitGatewayId || !table.TransitGatewayRouteTableId) continue;
      // Not paginated: AWS returns up to its default of 1,000 and flags more.
      // `MaxResults` is left unset because moto answers it with a 500.
      // SecurityAudit does not grant this call, so a role deployed before it
      // was needed refuses it: the table is then empty, and paths through
      // this gateway are missed rather than invented.
      const found = await client
        .send(
          new SearchTransitGatewayRoutesCommand({
            TransitGatewayRouteTableId: table.TransitGatewayRouteTableId,
            Filters: [{ Name: "state", Values: ["active", "blackhole"] }],
          }),
        )
        .catch((err: unknown) => {
          const name = err instanceof Error ? err.name : "";
          if (!REFUSED.has(name)) throw err;
          console.warn(
            `  vpc: ${name} reading transit gateway routes; paths through it are not modelled`,
          );
          return { Routes: [] };
        });
      const list = tablesOf.get(table.TransitGatewayId) ?? [];
      list.push({
        routeTableId: table.TransitGatewayRouteTableId,
        routes: (found.Routes ?? []).map((r) => ({
          destination: r.DestinationCidrBlock ?? r.PrefixListId ?? null,
          attachmentIds: (r.TransitGatewayAttachments ?? [])
            .map((t) => t.TransitGatewayAttachmentId)
            .filter((id): id is string => Boolean(id)),
          state: r.State ?? null,
        })),
      });
      tablesOf.set(table.TransitGatewayId, list);
    }
  }

  for await (const page of paginateDescribeTransitGateways({ client }, {})) {
    for (const tgw of page.TransitGateways ?? []) {
      if (!tgw.TransitGatewayId) continue;
      const tags = tagsToRecord(tgw.Tags);
      const arn =
        tgw.TransitGatewayArn ??
        ec2Arn(region, ctx.accountId, "transit-gateway", tgw.TransitGatewayId);
      const attached = attachments.get(tgw.TransitGatewayId) ?? [];
      add({
        arn,
        kind: "TransitGateway",
        name: nameFromTags(tags, tgw.TransitGatewayId),
        region,
        accountId: ctx.accountId,
        tags,
        properties: {
          transitGatewayId: tgw.TransitGatewayId,
          state: tgw.State ?? null,
          ownerId: tgw.OwnerId ?? null,
          attachments: attached,
          routeTables: tablesOf.get(tgw.TransitGatewayId) ?? [],
        },
        derived: {},
        raw: tgw,
      });
      for (const a of attached) {
        if (a.vpcId) relationships.push({ from: arn, to: vpcArn(a.vpcId), type: "ATTACHED_TO" });
      }
    }
  }

  // --- PrivateLink --------------------------------------------------------
  // Services this account provides, first, so an endpoint can be joined to one.
  const serviceArnByName = new Map<string, string>();
  for await (const page of paginateDescribeVpcEndpointServiceConfigurations({ client }, {})) {
    for (const svc of page.ServiceConfigurations ?? []) {
      if (!svc.ServiceId) continue;
      const tags = tagsToRecord(svc.Tags);
      const arn = ec2Arn(region, ctx.accountId, "vpc-endpoint-service", svc.ServiceId);
      if (svc.ServiceName) serviceArnByName.set(svc.ServiceName, arn);
      const nlbs = svc.NetworkLoadBalancerArns ?? [];
      add({
        arn,
        kind: "VpcEndpointService",
        name: nameFromTags(tags, svc.ServiceId),
        region,
        accountId: ctx.accountId,
        tags,
        properties: {
          serviceId: svc.ServiceId,
          serviceName: svc.ServiceName ?? null,
          state: svc.ServiceState ?? null,
          acceptanceRequired: svc.AcceptanceRequired ?? null,
          networkLoadBalancerArns: nlbs,
        },
        derived: {},
        raw: svc,
      });
      for (const nlb of nlbs) relationships.push({ from: arn, to: nlb, type: "SERVED_BY" });
    }
  }

  for await (const page of paginateDescribeVpcEndpoints({ client }, {})) {
    for (const ep of page.VpcEndpoints ?? []) {
      if (!ep.VpcEndpointId) continue;
      const tags = tagsToRecord(ep.Tags);
      const arn = ec2Arn(region, ctx.accountId, "vpc-endpoint", ep.VpcEndpointId);
      add({
        arn,
        kind: "VpcEndpoint",
        name: nameFromTags(tags, ep.VpcEndpointId),
        region,
        accountId: ctx.accountId,
        tags,
        properties: {
          vpcEndpointId: ep.VpcEndpointId,
          type: ep.VpcEndpointType ?? null,
          vpcId: ep.VpcId ?? null,
          serviceName: ep.ServiceName ?? null,
          state: ep.State ?? null,
        },
        derived: {},
        raw: ep,
      });
      if (ep.VpcId) relationships.push({ from: arn, to: vpcArn(ep.VpcId), type: "IN_VPC" });
      for (const subnetId of ep.SubnetIds ?? []) {
        relationships.push({
          from: arn,
          to: ec2Arn(region, ctx.accountId, "subnet", subnetId),
          type: "IN_SUBNET",
        });
      }
      for (const group of ep.Groups ?? []) {
        if (!group.GroupId) continue;
        relationships.push({
          from: arn,
          to: ec2Arn(region, ctx.accountId, "security-group", group.GroupId),
          type: "HAS_SECURITY_GROUP",
        });
      }
      const service = ep.ServiceName ? serviceArnByName.get(ep.ServiceName) : undefined;
      if (service) relationships.push({ from: arn, to: service, type: "CONNECTS_TO" });
    }
  }

  return { resources, relationships };
}
