/** The VPCs, subnets, route tables and gateways each environment is built on. */

import {
  AllocateAddressCommand,
  AttachInternetGatewayCommand,
  AssociateRouteTableCommand,
  CreateInternetGatewayCommand,
  CreateNatGatewayCommand,
  CreateRouteCommand,
  CreateRouteTableCommand,
  CreateSubnetCommand,
  CreateVpcCommand,
  type EC2Client,
} from "@aws-sdk/client-ec2";
import { tagSpec, type Tags } from "./seedHelpers.js";

/** Network scaffolding for one region: VPC, subnets, gateways, routing. */
export async function seedNetwork(
  client: EC2Client,
  opts: { cidr: string; name: string; tags: Tags; withNat: boolean },
) {
  const vpc = await client.send(
    new CreateVpcCommand({
      CidrBlock: opts.cidr,
      TagSpecifications: tagSpec("vpc", opts.name, opts.tags),
    }),
  );
  const vpcId = vpc.Vpc!.VpcId!;

  const igw = await client.send(
    new CreateInternetGatewayCommand({
      TagSpecifications: tagSpec("internet-gateway", `${opts.name}-igw`, opts.tags),
    }),
  );
  const igwId = igw.InternetGateway!.InternetGatewayId!;
  await client.send(new AttachInternetGatewayCommand({ InternetGatewayId: igwId, VpcId: vpcId }));

  const publicSubnet = await client.send(
    new CreateSubnetCommand({
      VpcId: vpcId,
      CidrBlock: opts.cidr.replace("0.0/16", "1.0/24"),
      TagSpecifications: tagSpec("subnet", `${opts.name}-public-a`, {
        ...opts.tags,
        Tier: "public",
      }),
    }),
  );
  const publicSubnetId = publicSubnet.Subnet!.SubnetId!;

  const privateSubnetA = await client.send(
    new CreateSubnetCommand({
      VpcId: vpcId,
      CidrBlock: opts.cidr.replace("0.0/16", "10.0/24"),
      TagSpecifications: tagSpec("subnet", `${opts.name}-private-a`, {
        ...opts.tags,
        Tier: "private",
      }),
    }),
  );
  const privateSubnetAId = privateSubnetA.Subnet!.SubnetId!;

  const privateSubnetB = await client.send(
    new CreateSubnetCommand({
      VpcId: vpcId,
      CidrBlock: opts.cidr.replace("0.0/16", "11.0/24"),
      TagSpecifications: tagSpec("subnet", `${opts.name}-private-b`, {
        ...opts.tags,
        Tier: "private",
      }),
    }),
  );
  const privateSubnetBId = privateSubnetB.Subnet!.SubnetId!;

  // A subnet is "public" because its route table sends 0.0.0.0/0 to an internet
  // gateway - not because of its name or tag. The scanner derives it that way,
  // so the seeder must model it that way.
  const publicRt = await client.send(
    new CreateRouteTableCommand({
      VpcId: vpcId,
      TagSpecifications: tagSpec("route-table", `${opts.name}-public-rt`, opts.tags),
    }),
  );
  const publicRtId = publicRt.RouteTable!.RouteTableId!;
  await client.send(
    new CreateRouteCommand({
      RouteTableId: publicRtId,
      DestinationCidrBlock: "0.0.0.0/0",
      GatewayId: igwId,
    }),
  );
  await client.send(
    new AssociateRouteTableCommand({ RouteTableId: publicRtId, SubnetId: publicSubnetId }),
  );

  let natId: string | undefined;
  let privateRtId: string | undefined;
  if (opts.withNat) {
    const eip = await client.send(new AllocateAddressCommand({ Domain: "vpc" }));
    const nat = await client.send(
      new CreateNatGatewayCommand({
        SubnetId: publicSubnetId,
        AllocationId: eip.AllocationId!,
        TagSpecifications: tagSpec("natgateway", `${opts.name}-nat`, opts.tags),
      }),
    );
    natId = nat.NatGateway!.NatGatewayId!;

    const privateRt = await client.send(
      new CreateRouteTableCommand({
        VpcId: vpcId,
        TagSpecifications: tagSpec("route-table", `${opts.name}-private-rt`, opts.tags),
      }),
    );
    privateRtId = privateRt.RouteTable!.RouteTableId!;
    await client.send(
      new CreateRouteCommand({
        RouteTableId: privateRtId,
        DestinationCidrBlock: "0.0.0.0/0",
        NatGatewayId: natId,
      }),
    );
    for (const subnetId of [privateSubnetAId, privateSubnetBId]) {
      await client.send(
        new AssociateRouteTableCommand({ RouteTableId: privateRtId, SubnetId: subnetId }),
      );
    }
  }

  return {
    vpcId,
    igwId,
    publicSubnetId,
    privateSubnetAId,
    privateSubnetBId,
    natId,
    publicRtId,
    privateRtId,
  };
}
