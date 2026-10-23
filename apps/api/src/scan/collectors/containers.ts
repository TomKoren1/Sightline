/**
 * ECS services and EKS clusters: where containers run, as what, and where.
 *
 * An ECS service carries the network placement and identity a host does - its
 * subnets, security groups, whether tasks get a public address, and the task
 * role every container runs as - so it joins the same reachability and
 * admin-usage analysis an instance does. An EKS cluster's API endpoint is the
 * door to everything in it; a public one open to 0.0.0.0/0 is an entry point.
 */

import {
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
  paginateListClusters,
  paginateListServices,
} from "@aws-sdk/client-ecs";
import {
  DescribeClusterCommand,
  paginateListClusters as paginateListEksClusters,
} from "@aws-sdk/client-eks";
import type { Relationship, Resource } from "@sightline/shared";

import { ecsClient, eksClient } from "../../aws/clients.js";
import { ec2Arn, regionArn } from "../../aws/arns.js";
import type { CollectorContext, CollectorOutput } from "./types.js";

/** DescribeServices takes at most ten at a time. */
const SERVICE_BATCH = 10;

export async function collectEcs(ctx: CollectorContext): Promise<CollectorOutput> {
  const region = ctx.region!;
  const client = ecsClient(ctx, region);
  const resources: Resource[] = [];
  const relationships: Relationship[] = [];
  const taskRoles = new Map<string, { taskRole: string | null; executionRole: string | null }>();

  for await (const page of paginateListClusters({ client }, {})) {
    for (const clusterArn of page.clusterArns ?? []) {
      const clusterName = clusterArn.split("/").pop() ?? clusterArn;
      resources.push({
        arn: clusterArn,
        kind: "EcsCluster",
        name: clusterName,
        region,
        accountId: ctx.accountId,
        tags: {},
        properties: {},
        derived: {},
      });
      relationships.push({
        from: clusterArn,
        to: regionArn(ctx.accountId, region),
        type: "IN_REGION",
      });

      const serviceArns: string[] = [];
      for await (const s of paginateListServices({ client }, { cluster: clusterArn })) {
        serviceArns.push(...(s.serviceArns ?? []));
      }
      for (let i = 0; i < serviceArns.length; i += SERVICE_BATCH) {
        const { services = [] } = await client.send(
          new DescribeServicesCommand({
            cluster: clusterArn,
            services: serviceArns.slice(i, i + SERVICE_BATCH),
          }),
        );
        for (const svc of services) {
          if (!svc.serviceArn || !svc.serviceName) continue;
          const taskDef = svc.taskDefinition ?? null;
          if (taskDef && !taskRoles.has(taskDef)) {
            const { taskDefinition } = await client.send(
              new DescribeTaskDefinitionCommand({ taskDefinition: taskDef }),
            );
            taskRoles.set(taskDef, {
              taskRole: taskDefinition?.taskRoleArn ?? null,
              executionRole: taskDefinition?.executionRoleArn ?? null,
            });
          }
          const roles = taskDef ? taskRoles.get(taskDef) : undefined;
          const network = svc.networkConfiguration?.awsvpcConfiguration;

          resources.push({
            arn: svc.serviceArn,
            kind: "EcsService",
            name: svc.serviceName,
            region,
            accountId: ctx.accountId,
            tags: {},
            properties: {
              cluster: clusterName,
              launchType: svc.launchType ?? null,
              desiredCount: svc.desiredCount ?? null,
              runningCount: svc.runningCount ?? null,
              taskDefinition: taskDef,
              taskRoleArn: roles?.taskRole ?? null,
              executionRoleArn: roles?.executionRole ?? null,
              assignPublicIp: network?.assignPublicIp === "ENABLED",
              targetGroups: (svc.loadBalancers ?? []).map((l) => l.targetGroupArn).filter(Boolean),
            },
            derived: {},
          });
          relationships.push({ from: svc.serviceArn, to: clusterArn, type: "IN_CLUSTER" });
          if (roles?.taskRole) {
            relationships.push({ from: svc.serviceArn, to: roles.taskRole, type: "EXECUTES_AS" });
          }
          for (const subnet of network?.subnets ?? []) {
            relationships.push({
              from: svc.serviceArn,
              to: ec2Arn(region, ctx.accountId, "subnet", subnet),
              type: "IN_SUBNET",
            });
          }
          for (const sg of network?.securityGroups ?? []) {
            relationships.push({
              from: svc.serviceArn,
              to: ec2Arn(region, ctx.accountId, "security-group", sg),
              type: "HAS_SECURITY_GROUP",
            });
          }
          // Registered in a target group, so a load balancer that forwards
          // there reaches the service's tasks.
          for (const lb of svc.loadBalancers ?? []) {
            if (lb.targetGroupArn) {
              relationships.push({
                from: lb.targetGroupArn,
                to: svc.serviceArn,
                type: "TARGETS",
                properties: { port: lb.containerPort ?? null },
              });
            }
          }
        }
      }
    }
  }
  return { resources, relationships };
}

export async function collectEks(ctx: CollectorContext): Promise<CollectorOutput> {
  const region = ctx.region!;
  const client = eksClient(ctx, region);
  const resources: Resource[] = [];
  const relationships: Relationship[] = [];

  for await (const page of paginateListEksClusters({ client }, {})) {
    for (const name of page.clusters ?? []) {
      const { cluster } = await client.send(new DescribeClusterCommand({ name }));
      if (!cluster?.arn) continue;
      const vpc = cluster.resourcesVpcConfig;
      resources.push({
        arn: cluster.arn,
        kind: "EksCluster",
        name,
        region,
        accountId: ctx.accountId,
        tags: cluster.tags ?? {},
        properties: {
          version: cluster.version ?? null,
          endpoint: cluster.endpoint ?? null,
          endpointPublicAccess: vpc?.endpointPublicAccess ?? false,
          endpointPrivateAccess: vpc?.endpointPrivateAccess ?? false,
          publicAccessCidrs: vpc?.publicAccessCidrs ?? [],
          roleArn: cluster.roleArn ?? null,
          secretsEncrypted: (cluster.encryptionConfig ?? []).length > 0,
          loggingEnabled: (cluster.logging?.clusterLogging ?? []).some((l) => l.enabled),
        },
        derived: {},
      });
      relationships.push({
        from: cluster.arn,
        to: regionArn(ctx.accountId, region),
        type: "IN_REGION",
      });
      if (cluster.roleArn) {
        relationships.push({ from: cluster.arn, to: cluster.roleArn, type: "EXECUTES_AS" });
      }
      for (const subnet of vpc?.subnetIds ?? []) {
        relationships.push({
          from: cluster.arn,
          to: ec2Arn(region, ctx.accountId, "subnet", subnet),
          type: "IN_SUBNET",
        });
      }
    }
  }
  return { resources, relationships };
}
