/**
 * Application and network load balancers, their listeners and target groups.
 *
 * In a real estate the internet rarely reaches an instance directly: it
 * reaches a load balancer, which forwards to a target group. Without these,
 * "what can reach the database" misses the most common way in. The verdict
 * that a path exists is the reachability analyser's; this records the parts.
 */

import {
  DescribeListenersCommand,
  DescribeTargetHealthCommand,
  paginateDescribeLoadBalancers,
  paginateDescribeTargetGroups,
  type Listener,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import type { Relationship, Resource } from "@sightline/shared";

import { elbv2Client } from "../../aws/clients.js";
import { ec2Arn, regionArn } from "../../aws/arns.js";
import type { CollectorContext, CollectorOutput } from "./types.js";

export async function collectElbv2(ctx: CollectorContext): Promise<CollectorOutput> {
  const region = ctx.region!;
  const client = elbv2Client(ctx, region);
  const resources: Resource[] = [];
  const relationships: Relationship[] = [];
  const sg = (id: string) => ec2Arn(region, ctx.accountId, "security-group", id);

  /** Target group ARN -> the load balancers whose listeners forward to it. */
  const forwardedBy = new Map<string, Set<string>>();

  for await (const page of paginateDescribeLoadBalancers({ client }, {})) {
    for (const lb of page.LoadBalancers ?? []) {
      if (!lb.LoadBalancerArn || !lb.LoadBalancerName) continue;
      const arn = lb.LoadBalancerArn;

      const listeners: Listener[] = [];
      let marker: string | undefined;
      do {
        const res = await client.send(
          new DescribeListenersCommand({ LoadBalancerArn: arn, Marker: marker }),
        );
        listeners.push(...(res.Listeners ?? []));
        marker = res.NextMarker;
      } while (marker);

      resources.push({
        arn,
        kind: "LoadBalancer",
        name: lb.LoadBalancerName,
        region,
        accountId: ctx.accountId,
        tags: {},
        properties: {
          type: lb.Type ?? null,
          scheme: lb.Scheme ?? null,
          internetFacing: lb.Scheme === "internet-facing",
          dnsName: lb.DNSName ?? null,
          vpcId: lb.VpcId ?? null,
          securityGroupIds: lb.SecurityGroups ?? [],
          subnetIds: (lb.AvailabilityZones ?? []).map((z) => z.SubnetId).filter(Boolean),
          listeners: listeners.map((l) => ({
            port: l.Port ?? null,
            protocol: l.Protocol ?? null,
            forwardsTo: (l.DefaultActions ?? []).flatMap((a) => [
              ...(a.TargetGroupArn ? [a.TargetGroupArn] : []),
              ...(a.ForwardConfig?.TargetGroups ?? []).map((t) => t.TargetGroupArn ?? ""),
            ]),
          })),
        },
        derived: {},
        raw: lb,
      });
      relationships.push({ from: arn, to: regionArn(ctx.accountId, region), type: "IN_REGION" });
      for (const id of lb.SecurityGroups ?? []) {
        relationships.push({ from: arn, to: sg(id), type: "HAS_SECURITY_GROUP" });
      }
      for (const zone of lb.AvailabilityZones ?? []) {
        if (zone.SubnetId) {
          relationships.push({
            from: arn,
            to: ec2Arn(region, ctx.accountId, "subnet", zone.SubnetId),
            type: "IN_SUBNET",
          });
        }
      }
      for (const listener of listeners) {
        for (const action of listener.DefaultActions ?? []) {
          const groups = [
            ...(action.TargetGroupArn ? [action.TargetGroupArn] : []),
            ...(action.ForwardConfig?.TargetGroups ?? []).map((t) => t.TargetGroupArn),
          ].filter((g): g is string => Boolean(g));
          for (const group of groups) {
            (forwardedBy.get(group) ?? forwardedBy.set(group, new Set()).get(group)!).add(arn);
          }
        }
      }
    }
  }

  for await (const page of paginateDescribeTargetGroups({ client }, {})) {
    for (const tg of page.TargetGroups ?? []) {
      if (!tg.TargetGroupArn || !tg.TargetGroupName) continue;
      const arn = tg.TargetGroupArn;
      const health = await client.send(new DescribeTargetHealthCommand({ TargetGroupArn: arn }));
      const targets = (health.TargetHealthDescriptions ?? []).map((t) => ({
        id: t.Target?.Id ?? null,
        port: t.Target?.Port ?? tg.Port ?? null,
        state: t.TargetHealth?.State ?? null,
      }));

      resources.push({
        arn,
        kind: "TargetGroup",
        name: tg.TargetGroupName,
        region,
        accountId: ctx.accountId,
        tags: {},
        properties: {
          port: tg.Port ?? null,
          protocol: tg.Protocol ?? null,
          targetType: tg.TargetType ?? null,
          vpcId: tg.VpcId ?? null,
          targets,
        },
        derived: {},
        raw: tg,
      });
      relationships.push({ from: arn, to: regionArn(ctx.accountId, region), type: "IN_REGION" });
      for (const lb of new Set([...(tg.LoadBalancerArns ?? []), ...(forwardedBy.get(arn) ?? [])])) {
        relationships.push({ from: lb, to: arn, type: "FORWARDS_TO" });
      }
      for (const target of targets) {
        if (!target.id) continue;
        // Instance targets are ids; Lambda targets are already ARNs. IP targets
        // name no resource, so they are recorded on the group and stop there.
        const to =
          tg.TargetType === "instance"
            ? ec2Arn(region, ctx.accountId, "instance", target.id)
            : tg.TargetType === "lambda"
              ? target.id
              : null;
        if (to) {
          relationships.push({
            from: arn,
            to,
            type: "TARGETS",
            properties: { port: target.port, state: target.state },
          });
        }
      }
    }
  }

  return { resources, relationships };
}
