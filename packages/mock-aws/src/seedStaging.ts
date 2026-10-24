/** A staging environment, smaller and sloppier than production. */

import {
  AssociateRouteTableCommand,
  CreateSecurityGroupCommand,
  CreateSubnetCommand,
  RunInstancesCommand,
  CreateNetworkAclCommand,
  CreateNetworkAclEntryCommand,
  DescribeNetworkAclsCommand,
  ReplaceNetworkAclAssociationCommand,
} from "@aws-sdk/client-ec2";
import { ec2 } from "./clients.js";
import { STAGING_REGION, TAGS } from "./topology.js";
import { allowIngress, tagSpec } from "./seedHelpers.js";
import { log } from "./seedHelpers.js";
import { seedNetwork } from "./seedNetwork.js";

/** Staging: smaller, with RDP open to the world. */
export async function seedStaging() {
  const client = ec2(STAGING_REGION);
  const net = await seedNetwork(client, {
    cidr: "10.1.0.0/16",
    name: "staging-vpc",
    tags: TAGS.staging,
    withNat: false,
  });

  const sg = await client.send(
    new CreateSecurityGroupCommand({
      GroupName: "staging-rdp-sg",
      Description: "Staging jump box",
      VpcId: net.vpcId,
      TagSpecifications: tagSpec("security-group", "staging-rdp-sg", TAGS.staging),
    }),
  );
  const sgId = sg.GroupId!;
  await allowIngress(client, sgId, 3389, { cidr: "0.0.0.0/0" }, "RDP from anywhere");

  await client.send(
    new RunInstancesCommand({
      ImageId: "ami-0c02fb55956c7d316",
      MinCount: 1,
      MaxCount: 1,
      InstanceType: "t3.small",
      SubnetId: net.publicSubnetId,
      SecurityGroupIds: [sgId],
      TagSpecifications: tagSpec("instance", "staging-rdp-host", TAGS.staging),
    }),
  );

  // The inverse trap: SSH open to the world in the group and a public subnet,
  // but the subnet's network ACL denies it. Not reachable.
  const quarantine = await client.send(
    new CreateSubnetCommand({
      VpcId: net.vpcId,
      CidrBlock: "10.1.9.0/24",
      AvailabilityZone: `${STAGING_REGION}a`,
      TagSpecifications: tagSpec("subnet", "staging-quarantine", TAGS.staging),
    }),
  );
  const quarantineId = quarantine.Subnet!.SubnetId!;
  await client.send(
    new AssociateRouteTableCommand({ RouteTableId: net.publicRtId, SubnetId: quarantineId }),
  );
  const acl = await client.send(
    new CreateNetworkAclCommand({
      VpcId: net.vpcId,
      TagSpecifications: tagSpec("network-acl", "staging-quarantine-acl", TAGS.staging),
    }),
  );
  const aclId = acl.NetworkAcl!.NetworkAclId!;
  for (const [ruleNumber, egress, action, ports] of [
    [50, false, "deny", { From: 22, To: 22 }],
    [100, false, "allow", undefined],
    [100, true, "allow", undefined],
  ] as const) {
    await client.send(
      new CreateNetworkAclEntryCommand({
        NetworkAclId: aclId,
        RuleNumber: ruleNumber,
        Egress: egress,
        RuleAction: action,
        Protocol: ports ? "6" : "-1",
        CidrBlock: "0.0.0.0/0",
        ...(ports ? { PortRange: ports } : {}),
      }),
    );
  }
  const current = await client.send(
    new DescribeNetworkAclsCommand({
      Filters: [{ Name: "association.subnet-id", Values: [quarantineId] }],
    }),
  );
  const associationId = current.NetworkAcls?.[0]?.Associations?.find(
    (a) => a.SubnetId === quarantineId,
  )?.NetworkAclAssociationId;
  if (associationId) {
    await client.send(
      new ReplaceNetworkAclAssociationCommand({
        AssociationId: associationId,
        NetworkAclId: aclId,
      }),
    );
  }
  const sshSg = await client.send(
    new CreateSecurityGroupCommand({
      GroupName: "staging-ssh-sg",
      Description: "Quarantined host",
      VpcId: net.vpcId,
      TagSpecifications: tagSpec("security-group", "staging-ssh-sg", TAGS.staging),
    }),
  );
  await allowIngress(client, sshSg.GroupId!, 22, { cidr: "0.0.0.0/0" }, "SSH from anywhere");
  await client.send(
    new RunInstancesCommand({
      ImageId: "ami-0c02fb55956c7d316",
      MinCount: 1,
      MaxCount: 1,
      InstanceType: "t3.micro",
      SubnetId: quarantineId,
      SecurityGroupIds: [sshSg.GroupId!],
      TagSpecifications: tagSpec("instance", "staging-ssh-host", TAGS.staging),
    }),
  );

  log(`${STAGING_REGION}: VPC, 2 instances, RDP open to 0.0.0.0/0, SSH open but blocked by a NACL`);
}
