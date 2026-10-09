/**
 * RDS instances and their subnet groups.
 *
 * `PubliclyAccessible` is recorded but deliberately NOT treated as the answer
 * to "is this database exposed?". It only controls whether AWS gives the
 * instance a public endpoint; whether anything can actually connect is decided
 * by security groups and routing. The reachability analyser settles that, and
 * the mock account contains a database that is publicly accessible and
 * reachable by nobody precisely to keep us honest about the difference.
 */

import { paginateDescribeDBInstances, paginateDescribeDBSubnetGroups } from "@aws-sdk/client-rds";
import type { Relationship, Resource } from "@sightline/shared";

import { rdsClient } from "../../aws/clients.js";
import { ec2Arn, regionArn, tagsToRecord } from "../../aws/arns.js";
import type { CollectorContext, CollectorOutput } from "./types.js";

export async function collectRds(ctx: CollectorContext): Promise<CollectorOutput> {
  const region = ctx.region!;
  const client = rdsClient(region);
  const resources: Resource[] = [];
  const relationships: Relationship[] = [];
  const inRegion = (arn: string): Relationship => ({
    from: arn,
    to: regionArn(ctx.accountId, region),
    type: "IN_REGION",
  });

  for await (const page of paginateDescribeDBSubnetGroups({ client }, {})) {
    for (const group of page.DBSubnetGroups ?? []) {
      if (!group.DBSubnetGroupName) continue;
      const arn =
        group.DBSubnetGroupArn ??
        `arn:aws:rds:${region}:${ctx.accountId}:subgrp:${group.DBSubnetGroupName}`;
      resources.push({
        arn,
        kind: "DbSubnetGroup",
        name: group.DBSubnetGroupName,
        region,
        accountId: ctx.accountId,
        tags: {},
        properties: {
          name: group.DBSubnetGroupName,
          vpcId: group.VpcId,
          subnetIds: (group.Subnets ?? []).map((s) => s.SubnetIdentifier).filter(Boolean),
        },
        derived: {},
        raw: group,
      });
      relationships.push(inRegion(arn));
      for (const subnet of group.Subnets ?? []) {
        if (!subnet.SubnetIdentifier) continue;
        relationships.push({
          from: arn,
          to: ec2Arn(region, ctx.accountId, "subnet", subnet.SubnetIdentifier),
          type: "USES_SUBNET_GROUP",
        });
      }
    }
  }

  for await (const page of paginateDescribeDBInstances({ client }, {})) {
    for (const db of page.DBInstances ?? []) {
      if (!db.DBInstanceIdentifier) continue;
      const arn =
        db.DBInstanceArn ?? `arn:aws:rds:${region}:${ctx.accountId}:db:${db.DBInstanceIdentifier}`;
      const tags = tagsToRecord(db.TagList);

      resources.push({
        arn,
        kind: "RdsInstance",
        name: db.DBInstanceIdentifier,
        region,
        accountId: ctx.accountId,
        tags,
        properties: {
          dbInstanceIdentifier: db.DBInstanceIdentifier,
          engine: db.Engine,
          engineVersion: db.EngineVersion,
          instanceClass: db.DBInstanceClass,
          allocatedStorageGib: db.AllocatedStorage ?? 0,
          publiclyAccessible: db.PubliclyAccessible ?? false,
          storageEncrypted: db.StorageEncrypted ?? false,
          multiAz: db.MultiAZ ?? false,
          status: db.DBInstanceStatus,
          endpoint: db.Endpoint?.Address ?? null,
          port: db.Endpoint?.Port ?? null,
          dbSubnetGroupName: db.DBSubnetGroup?.DBSubnetGroupName ?? null,
          vpcId: db.DBSubnetGroup?.VpcId ?? null,
          securityGroupIds: (db.VpcSecurityGroups ?? [])
            .map((g) => g.VpcSecurityGroupId)
            .filter(Boolean),
        },
        derived: {},
        raw: db,
      });
      relationships.push(inRegion(arn));

      for (const sg of db.VpcSecurityGroups ?? []) {
        if (!sg.VpcSecurityGroupId) continue;
        relationships.push({
          from: arn,
          to: ec2Arn(region, ctx.accountId, "security-group", sg.VpcSecurityGroupId),
          type: "HAS_SECURITY_GROUP",
        });
      }
      // Subnet membership comes via the subnet group, and it is what places
      // the database on the private side of the network.
      for (const subnet of db.DBSubnetGroup?.Subnets ?? []) {
        if (!subnet.SubnetIdentifier) continue;
        relationships.push({
          from: arn,
          to: ec2Arn(region, ctx.accountId, "subnet", subnet.SubnetIdentifier),
          type: "IN_SUBNET",
        });
      }
    }
  }

  return { resources, relationships };
}
