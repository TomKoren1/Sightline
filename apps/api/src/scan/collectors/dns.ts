/**
 * Route 53 hosted zones and Auto Scaling groups.
 *
 * A zone's records are where a public name lands: which load balancer,
 * distribution or API a customer's domain points at. Records are kept on the
 * zone and joined to resources by domain in `linkEntryPoints`.
 */

import { DescribeAutoScalingGroupsCommand } from "@aws-sdk/client-auto-scaling";
import {
  ListResourceRecordSetsCommand,
  paginateListHostedZones,
  type ResourceRecordSet,
} from "@aws-sdk/client-route-53";
import type { Relationship, Resource } from "@sightline/shared";

import { autoScalingClient, route53Client } from "../../aws/clients.js";
import { ec2Arn, regionArn } from "../../aws/arns.js";
import type { CollectorContext, CollectorOutput } from "./types.js";

export async function collectRoute53(ctx: CollectorContext): Promise<CollectorOutput> {
  const client = route53Client(ctx);
  const resources: Resource[] = [];

  for await (const page of paginateListHostedZones({ client }, {})) {
    for (const zone of page.HostedZones ?? []) {
      if (!zone.Id || !zone.Name) continue;
      const records: ResourceRecordSet[] = [];
      let next: { name?: string; type?: string } = {};
      do {
        const res = await client.send(
          new ListResourceRecordSetsCommand({
            HostedZoneId: zone.Id,
            ...(next.name ? { StartRecordName: next.name } : {}),
            ...(next.type ? { StartRecordType: next.type as never } : {}),
          }),
        );
        records.push(...(res.ResourceRecordSets ?? []));
        next = res.IsTruncated ? { name: res.NextRecordName, type: res.NextRecordType } : {};
      } while (next.name);

      const id = zone.Id.replace(/^\/hostedzone\//, "");
      resources.push({
        arn: `arn:aws:route53:::hostedzone/${id}`,
        kind: "HostedZone",
        name: zone.Name.replace(/\.$/, ""),
        region: null,
        accountId: ctx.accountId,
        tags: {},
        properties: {
          privateZone: zone.Config?.PrivateZone ?? false,
          recordCount: zone.ResourceRecordSetCount ?? records.length,
          records: records
            .filter((r) => ["A", "AAAA", "CNAME"].includes(r.Type ?? ""))
            .map((r) => ({
              name: (r.Name ?? "").replace(/\.$/, ""),
              type: r.Type ?? null,
              target:
                r.AliasTarget?.DNSName?.replace(/\.$/, "") ?? r.ResourceRecords?.[0]?.Value ?? null,
              alias: Boolean(r.AliasTarget),
            })),
        },
        derived: {},
      });
    }
  }
  return { resources, relationships: [] };
}

export async function collectAutoScaling(ctx: CollectorContext): Promise<CollectorOutput> {
  const region = ctx.region!;
  const client = autoScalingClient(ctx, region);
  const resources: Resource[] = [];
  const relationships: Relationship[] = [];

  let token: string | undefined;
  do {
    const res = await client.send(new DescribeAutoScalingGroupsCommand({ NextToken: token }));
    for (const group of res.AutoScalingGroups ?? []) {
      if (!group.AutoScalingGroupARN || !group.AutoScalingGroupName) continue;
      resources.push({
        arn: group.AutoScalingGroupARN,
        kind: "AutoScalingGroup",
        name: group.AutoScalingGroupName,
        region,
        accountId: ctx.accountId,
        tags: Object.fromEntries((group.Tags ?? []).map((t) => [t.Key ?? "", t.Value ?? ""])),
        properties: {
          minSize: group.MinSize ?? null,
          maxSize: group.MaxSize ?? null,
          desiredCapacity: group.DesiredCapacity ?? null,
          launchTemplate: group.LaunchTemplate?.LaunchTemplateName ?? null,
          targetGroups: group.TargetGroupARNs ?? [],
        },
        derived: {},
      });
      relationships.push({
        from: group.AutoScalingGroupARN,
        to: regionArn(ctx.accountId, region),
        type: "IN_REGION",
      });
      for (const instance of group.Instances ?? []) {
        if (!instance.InstanceId) continue;
        relationships.push({
          from: group.AutoScalingGroupARN,
          to: ec2Arn(region, ctx.accountId, "instance", instance.InstanceId),
          type: "MANAGES",
        });
      }
    }
    token = res.NextToken;
  } while (token);
  return { resources, relationships };
}
