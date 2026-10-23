/**
 * Production's neighbours: three VPCs that reach into it, or look as if they do.
 *
 *   analytics-vpc   peered, routed both ways: its worker reaches the database,
 *                   and the app tier through a PrivateLink endpoint
 *   partner-vpc     peered, routed one way only: admitted by the database's
 *                   group, and still unable to reach it
 *   shared-vpc      on a transit gateway with prod: its CI runner reaches the
 *                   app tier. Its status page is public only through the VPC's
 *                   main route table, which its subnet uses by default
 */

import {
  AcceptVpcPeeringConnectionCommand,
  AssociateRouteTableCommand,
  AssociateTransitGatewayRouteTableCommand,
  AttachInternetGatewayCommand,
  CreateInternetGatewayCommand,
  CreateRouteCommand,
  CreateRouteTableCommand,
  CreateSecurityGroupCommand,
  CreateSubnetCommand,
  CreateTransitGatewayCommand,
  CreateTransitGatewayRouteCommand,
  CreateTransitGatewayRouteTableCommand,
  CreateTransitGatewayVpcAttachmentCommand,
  CreateVpcCommand,
  CreateVpcEndpointCommand,
  CreateVpcEndpointServiceConfigurationCommand,
  CreateVpcPeeringConnectionCommand,
  DescribeRouteTablesCommand,
  DescribeTransitGatewayAttachmentsCommand,
  RunInstancesCommand,
  type EC2Client,
} from "@aws-sdk/client-ec2";
import {
  CreateListenerCommand,
  CreateLoadBalancerCommand,
  CreateTargetGroupCommand,
  RegisterTargetsCommand,
} from "@aws-sdk/client-elastic-load-balancing-v2";

import { ec2, elbv2 } from "./clients.js";
import { allowIngress, tagSpec } from "./seedHelpers.js";
import { PROD_REGION, TAGS } from "./topology.js";

const PROD_CIDR = "10.0.0.0/16";

async function vpcWithSubnet(client: EC2Client, name: string, cidr: string, subnetCidr: string) {
  const vpc = await client.send(
    new CreateVpcCommand({ CidrBlock: cidr, TagSpecifications: tagSpec("vpc", name, TAGS.prod) }),
  );
  const vpcId = vpc.Vpc!.VpcId!;
  const subnet = await client.send(
    new CreateSubnetCommand({
      VpcId: vpcId,
      CidrBlock: subnetCidr,
      AvailabilityZone: `${PROD_REGION}a`,
      TagSpecifications: tagSpec("subnet", `${name.replace(/-vpc$/, "")}-private`, TAGS.prod),
    }),
  );
  return { vpcId, subnetId: subnet.Subnet!.SubnetId! };
}

/** A route table of the subnet's own, carrying the given routes. */
async function ownRoutes(
  client: EC2Client,
  vpcId: string,
  subnetId: string,
  name: string,
  routes: { cidr: string; peering?: string; tgw?: string }[],
) {
  const rt = await client.send(
    new CreateRouteTableCommand({
      VpcId: vpcId,
      TagSpecifications: tagSpec("route-table", name, TAGS.prod),
    }),
  );
  const id = rt.RouteTable!.RouteTableId!;
  for (const r of routes) await addRoute(client, id, r);
  await client.send(new AssociateRouteTableCommand({ RouteTableId: id, SubnetId: subnetId }));
}

const addRoute = (
  client: EC2Client,
  routeTableId: string,
  r: { cidr: string; peering?: string; tgw?: string },
) =>
  client.send(
    new CreateRouteCommand({
      RouteTableId: routeTableId,
      DestinationCidrBlock: r.cidr,
      ...(r.peering ? { VpcPeeringConnectionId: r.peering } : {}),
      ...(r.tgw ? { TransitGatewayId: r.tgw } : {}),
    }),
  );

async function peer(client: EC2Client, from: string, to: string, name: string) {
  const pcx = await client.send(
    new CreateVpcPeeringConnectionCommand({
      VpcId: from,
      PeerVpcId: to,
      TagSpecifications: tagSpec("vpc-peering-connection", name, TAGS.prod),
    }),
  );
  const id = pcx.VpcPeeringConnection!.VpcPeeringConnectionId!;
  await client.send(new AcceptVpcPeeringConnectionCommand({ VpcPeeringConnectionId: id }));
  return id;
}

async function instance(client: EC2Client, name: string, subnetId: string, sgId: string) {
  await client.send(
    new RunInstancesCommand({
      ImageId: "ami-0c02fb55956c7d316",
      MinCount: 1,
      MaxCount: 1,
      InstanceType: "t3.small",
      SubnetId: subnetId,
      SecurityGroupIds: [sgId],
      TagSpecifications: tagSpec("instance", name, TAGS.prod),
    }),
  );
}

async function group(client: EC2Client, vpcId: string, name: string) {
  const sg = await client.send(
    new CreateSecurityGroupCommand({
      GroupName: name,
      Description: name,
      VpcId: vpcId,
      TagSpecifications: tagSpec("security-group", name, TAGS.prod),
    }),
  );
  return sg.GroupId!;
}

export async function seedConnectivity(opts: {
  prodVpcId: string;
  prodPrivateRtId: string;
  prodPrivateSubnetId: string;
  dbSg: string;
  appSg: string;
  app1: string;
}) {
  const client = ec2(PROD_REGION);

  // --- analytics: peered, and routed both ways ----------------------------
  const analytics = await vpcWithSubnet(client, "analytics-vpc", "10.1.0.0/16", "10.1.1.0/24");
  const toAnalytics = await peer(client, analytics.vpcId, opts.prodVpcId, "prod-analytics-peering");
  await ownRoutes(client, analytics.vpcId, analytics.subnetId, "analytics-private-rt", [
    { cidr: PROD_CIDR, peering: toAnalytics },
  ]);
  await addRoute(client, opts.prodPrivateRtId, { cidr: "10.1.0.0/16", peering: toAnalytics });
  await allowIngress(client, opts.dbSg, 5432, { cidr: "10.1.0.0/16" }, "Postgres from analytics");
  const analyticsSg = await group(client, analytics.vpcId, "analytics-worker-sg");
  await instance(client, "analytics-worker", analytics.subnetId, analyticsSg);

  // --- partner: peered, with no route back --------------------------------
  // Its group admits the range and its own table routes to prod; prod's
  // tables have no route to it, so no reply ever arrives.
  const partner = await vpcWithSubnet(client, "partner-vpc", "10.4.0.0/16", "10.4.1.0/24");
  const toPartner = await peer(client, partner.vpcId, opts.prodVpcId, "prod-partner-peering");
  await ownRoutes(client, partner.vpcId, partner.subnetId, "partner-private-rt", [
    { cidr: PROD_CIDR, peering: toPartner },
  ]);
  await allowIngress(client, opts.dbSg, 5432, { cidr: "10.4.0.0/16" }, "Postgres from partner");
  const partnerSg = await group(client, partner.vpcId, "partner-reporting-sg");
  await instance(client, "partner-reporting", partner.subnetId, partnerSg);

  // --- shared services: a transit gateway --------------------------------
  const shared = await vpcWithSubnet(client, "shared-vpc", "10.3.0.0/16", "10.3.1.0/24");
  const tgw = await client.send(
    new CreateTransitGatewayCommand({
      Description: "Northwind hub",
      Options: { DefaultRouteTableAssociation: "disable", DefaultRouteTablePropagation: "disable" },
      TagSpecifications: tagSpec("transit-gateway", "northwind-tgw", TAGS.prod),
    }),
  );
  const tgwId = tgw.TransitGateway!.TransitGatewayId!;
  const attach = async (vpcId: string, subnetId: string) =>
    (
      await client.send(
        new CreateTransitGatewayVpcAttachmentCommand({
          TransitGatewayId: tgwId,
          VpcId: vpcId,
          SubnetIds: [subnetId],
        }),
      )
    ).TransitGatewayVpcAttachment!.TransitGatewayAttachmentId!;
  const prodAttachment = await attach(opts.prodVpcId, opts.prodPrivateSubnetId);
  const sharedAttachment = await attach(shared.vpcId, shared.subnetId);
  // The routes go in whichever table the attachments are associated with.
  // moto associates them with the TGW's default table even when told not to,
  // and records no later association, so the seed asks rather than assumes.
  const described = await client.send(
    new DescribeTransitGatewayAttachmentsCommand({
      TransitGatewayAttachmentIds: [prodAttachment, sharedAttachment],
    }),
  );
  let tableId = described.TransitGatewayAttachments?.[0]?.Association?.TransitGatewayRouteTableId;
  if (!tableId) {
    const table = await client.send(
      new CreateTransitGatewayRouteTableCommand({ TransitGatewayId: tgwId }),
    );
    tableId = table.TransitGatewayRouteTable!.TransitGatewayRouteTableId!;
    for (const attachmentId of [prodAttachment, sharedAttachment]) {
      await client.send(
        new AssociateTransitGatewayRouteTableCommand({
          TransitGatewayRouteTableId: tableId,
          TransitGatewayAttachmentId: attachmentId,
        }),
      );
    }
  }
  for (const [attachmentId, cidr] of [
    [prodAttachment, PROD_CIDR],
    [sharedAttachment, "10.3.0.0/16"],
  ] as const) {
    await client.send(
      new CreateTransitGatewayRouteCommand({
        TransitGatewayRouteTableId: tableId,
        DestinationCidrBlock: cidr,
        TransitGatewayAttachmentId: attachmentId,
      }),
    );
  }
  await ownRoutes(client, shared.vpcId, shared.subnetId, "shared-private-rt", [
    { cidr: PROD_CIDR, tgw: tgwId },
  ]);
  await addRoute(client, opts.prodPrivateRtId, { cidr: "10.3.0.0/16", tgw: tgwId });
  await allowIngress(client, opts.appSg, 9000, { cidr: "10.3.0.0/16" }, "App traffic from CI");
  const ciSg = await group(client, shared.vpcId, "shared-ci-sg");
  await instance(client, "shared-ci-runner", shared.subnetId, ciSg);

  // The status page's subnet has no route table of its own, so it uses the
  // VPC's main one - given a default route to the internet here.
  const igw = await client.send(
    new CreateInternetGatewayCommand({
      TagSpecifications: tagSpec("internet-gateway", "shared-igw", TAGS.prod),
    }),
  );
  const igwId = igw.InternetGateway!.InternetGatewayId!;
  await client.send(
    new AttachInternetGatewayCommand({ InternetGatewayId: igwId, VpcId: shared.vpcId }),
  );
  const main = await client.send(
    new DescribeRouteTablesCommand({
      Filters: [
        { Name: "vpc-id", Values: [shared.vpcId] },
        { Name: "association.main", Values: ["true"] },
      ],
    }),
  );
  await client.send(
    new CreateRouteCommand({
      RouteTableId: main.RouteTables![0]!.RouteTableId!,
      DestinationCidrBlock: "0.0.0.0/0",
      GatewayId: igwId,
    }),
  );
  const statusSubnet = await client.send(
    new CreateSubnetCommand({
      VpcId: shared.vpcId,
      CidrBlock: "10.3.2.0/24",
      AvailabilityZone: `${PROD_REGION}a`,
      TagSpecifications: tagSpec("subnet", "shared-status", TAGS.prod),
    }),
  );
  const statusSg = await group(client, shared.vpcId, "status-page-sg");
  await allowIngress(client, statusSg, 443, { cidr: "0.0.0.0/0" }, "HTTPS from the internet");
  await instance(client, "status-page", statusSubnet.Subnet!.SubnetId!, statusSg);

  // --- PrivateLink: the app tier, offered to analytics --------------------
  const lb = elbv2(PROD_REGION);
  const nlb = await lb.send(
    new CreateLoadBalancerCommand({
      Name: "prod-orders-nlb",
      Type: "network",
      Scheme: "internal",
      Subnets: [opts.prodPrivateSubnetId],
    }),
  );
  const nlbArn = nlb.LoadBalancers![0]!.LoadBalancerArn!;
  const tg = await lb.send(
    new CreateTargetGroupCommand({
      Name: "prod-orders-tg",
      Protocol: "TCP",
      Port: 9000,
      VpcId: opts.prodVpcId,
      TargetType: "instance",
    }),
  );
  const tgArn = tg.TargetGroups![0]!.TargetGroupArn!;
  await lb.send(
    new RegisterTargetsCommand({ TargetGroupArn: tgArn, Targets: [{ Id: opts.app1 }] }),
  );
  await lb.send(
    new CreateListenerCommand({
      LoadBalancerArn: nlbArn,
      Protocol: "TCP",
      Port: 9000,
      DefaultActions: [{ Type: "forward", TargetGroupArn: tgArn }],
    }),
  );
  const service = await client.send(
    new CreateVpcEndpointServiceConfigurationCommand({ NetworkLoadBalancerArns: [nlbArn] }),
  );
  const endpointSg = await group(client, analytics.vpcId, "analytics-orders-endpoint-sg");
  await allowIngress(client, endpointSg, 9000, { cidr: "10.1.0.0/16" }, "Orders from analytics");
  await client.send(
    new CreateVpcEndpointCommand({
      VpcId: analytics.vpcId,
      VpcEndpointType: "Interface",
      ServiceName: service.ServiceConfiguration!.ServiceName!,
      SubnetIds: [analytics.subnetId],
      SecurityGroupIds: [endpointSg],
      TagSpecifications: tagSpec("vpc-endpoint", "analytics-orders-endpoint", TAGS.prod),
    }),
  );
}
