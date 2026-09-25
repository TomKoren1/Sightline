/**
 * Compute: instances, EBS volumes and elastic IPs.
 *
 * Volumes and addresses are collected even when attached to nothing - in fact
 * *especially* then, since an unattached volume is the clearest example of the
 * "costing money but not being used" question the brief asks about.
 */

import {
  paginateDescribeInstances,
  paginateDescribeVolumes,
  DescribeAddressesCommand,
} from "@aws-sdk/client-ec2";
import type { Relationship, Resource } from "@daveio/shared";

import { ec2Client } from "../../aws/clients.js";
import { ec2Arn, iamArn, nameFromTags, regionArn, tagsToRecord } from "../../aws/arns.js";
import type { CollectorContext, CollectorOutput } from "./types.js";

export async function collectEc2(ctx: CollectorContext): Promise<CollectorOutput> {
  const region = ctx.region!;
  const client = ec2Client(region);
  const resources: Resource[] = [];
  const relationships: Relationship[] = [];
  const inRegion = (arn: string): Relationship => ({
    from: arn,
    to: regionArn(ctx.accountId, region),
    type: "IN_REGION",
  });

  // --- Instances ----------------------------------------------------------
  for await (const page of paginateDescribeInstances({ client }, {})) {
    for (const reservation of page.Reservations ?? []) {
      for (const instance of reservation.Instances ?? []) {
        if (!instance.InstanceId) continue;
        const tags = tagsToRecord(instance.Tags);
        const arn = ec2Arn(region, ctx.accountId, "instance", instance.InstanceId);
        const state = instance.State?.Name ?? "unknown";

        resources.push({
          arn,
          kind: "Ec2Instance",
          name: nameFromTags(tags, instance.InstanceId),
          region,
          accountId: ctx.accountId,
          tags,
          properties: {
            instanceId: instance.InstanceId,
            instanceType: instance.InstanceType,
            state,
            privateIpAddress: instance.PrivateIpAddress ?? null,
            publicIpAddress: instance.PublicIpAddress ?? null,
            subnetId: instance.SubnetId ?? null,
            vpcId: instance.VpcId ?? null,
            launchTime: instance.LaunchTime?.toISOString() ?? null,
            iamInstanceProfileArn: instance.IamInstanceProfile?.Arn ?? null,
            securityGroupIds: (instance.SecurityGroups ?? []).map((g) => g.GroupId).filter(Boolean),
          },
          derived: {},
          raw: instance,
        });
        relationships.push(inRegion(arn));

        if (instance.SubnetId) {
          relationships.push({
            from: arn,
            to: ec2Arn(region, ctx.accountId, "subnet", instance.SubnetId),
            type: "IN_SUBNET",
          });
        }
        for (const sg of instance.SecurityGroups ?? []) {
          if (!sg.GroupId) continue;
          relationships.push({
            from: arn,
            to: ec2Arn(region, ctx.accountId, "security-group", sg.GroupId),
            type: "HAS_SECURITY_GROUP",
          });
        }
        // The instance profile is the bridge between the compute graph and the
        // IAM graph - it is how "which instances run as an administrator?"
        // becomes answerable.
        if (instance.IamInstanceProfile?.Arn) {
          const profileName = instance.IamInstanceProfile.Arn.split("/").pop();
          if (profileName) {
            relationships.push({
              from: arn,
              to: iamArn(ctx.accountId, "instance-profile", profileName),
              type: "HAS_INSTANCE_PROFILE",
            });
          }
        }
      }
    }
  }

  // --- EBS volumes --------------------------------------------------------
  for await (const page of paginateDescribeVolumes({ client }, {})) {
    for (const volume of page.Volumes ?? []) {
      if (!volume.VolumeId) continue;
      const tags = tagsToRecord(volume.Tags);
      const arn = ec2Arn(region, ctx.accountId, "volume", volume.VolumeId);
      const attachments = volume.Attachments ?? [];

      resources.push({
        arn,
        kind: "EbsVolume",
        name: nameFromTags(tags, volume.VolumeId),
        region,
        accountId: ctx.accountId,
        tags,
        properties: {
          volumeId: volume.VolumeId,
          sizeGib: volume.Size ?? 0,
          volumeType: volume.VolumeType ?? "gp2",
          state: volume.State,
          encrypted: volume.Encrypted ?? false,
          createdAt: volume.CreateTime?.toISOString() ?? null,
          attachedTo: attachments[0]?.InstanceId ?? null,
        },
        derived: {},
        raw: volume,
      });
      relationships.push(inRegion(arn));
      for (const att of attachments) {
        if (!att.InstanceId) continue;
        relationships.push({
          from: arn,
          to: ec2Arn(region, ctx.accountId, "instance", att.InstanceId),
          type: "ATTACHED_TO",
          properties: { device: att.Device ?? null },
        });
      }
    }
  }

  // --- Elastic IPs --------------------------------------------------------
  // DescribeAddresses has no paginator: the API returns everything at once.
  const addresses = await client.send(new DescribeAddressesCommand({}));
  for (const address of addresses.Addresses ?? []) {
    const id = address.AllocationId ?? address.PublicIp;
    if (!id) continue;
    const tags = tagsToRecord(address.Tags);
    const arn = ec2Arn(region, ctx.accountId, "elastic-ip", id);

    resources.push({
      arn,
      kind: "ElasticIp",
      name: nameFromTags(tags, address.PublicIp ?? id),
      region,
      accountId: ctx.accountId,
      tags,
      properties: {
        allocationId: address.AllocationId ?? null,
        publicIp: address.PublicIp ?? null,
        associationId: address.AssociationId ?? null,
        instanceId: address.InstanceId ?? null,
        networkInterfaceId: address.NetworkInterfaceId ?? null,
      },
      derived: {},
      raw: address,
    });
    relationships.push(inRegion(arn));
    if (address.InstanceId) {
      relationships.push({
        from: arn,
        to: ec2Arn(region, ctx.accountId, "instance", address.InstanceId),
        type: "ATTACHED_TO",
      });
    }
  }

  return { resources, relationships };
}
