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
  DescribeNodegroupCommand,
  DescribePodIdentityAssociationCommand,
  paginateListClusters as paginateListEksClusters,
  paginateListNodegroups,
  paginateListPodIdentityAssociations,
  type EKSClient,
} from "@aws-sdk/client-eks";
import { errorMessage, type Relationship, type Resource } from "@sightline/shared";

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
          // Matched against IAM trust policies by the IRSA analyser.
          oidcIssuer: cluster.identity?.oidc?.issuer ?? null,
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
      await collectNodeGroups(ctx, client, cluster.arn, name, resources, relationships);
      relationships.push(...(await podIdentityGrants(client, cluster.arn, name)));
    }
  }
  return { resources, relationships };
}

/** Managed node groups: the instances' role, where they run, and who can SSH in. */
async function collectNodeGroups(
  ctx: CollectorContext,
  client: EKSClient,
  clusterArn: string,
  clusterName: string,
  resources: Resource[],
  relationships: Relationship[],
) {
  const region = ctx.region!;
  for await (const page of paginateListNodegroups({ client }, { clusterName })) {
    for (const nodegroupName of page.nodegroups ?? []) {
      const { nodegroup: ng } = await client.send(
        new DescribeNodegroupCommand({ clusterName, nodegroupName }),
      );
      if (!ng?.nodegroupArn) continue;
      const remote = ng.remoteAccess;
      // A key with no source groups is AWS's default for remote access:
      // port 22 open to 0.0.0.0/0 on every node.
      const sshOpenToWorld =
        Boolean(remote?.ec2SshKey) && (remote?.sourceSecurityGroups ?? []).length === 0;
      resources.push({
        arn: ng.nodegroupArn,
        kind: "EksNodeGroup",
        name: nodegroupName,
        region,
        accountId: ctx.accountId,
        tags: ng.tags ?? {},
        properties: {
          clusterName,
          status: ng.status ?? null,
          version: ng.version ?? null,
          capacityType: ng.capacityType ?? null,
          amiType: ng.amiType ?? null,
          instanceTypes: ng.instanceTypes ?? [],
          minSize: ng.scalingConfig?.minSize ?? null,
          maxSize: ng.scalingConfig?.maxSize ?? null,
          desiredSize: ng.scalingConfig?.desiredSize ?? null,
          nodeRole: ng.nodeRole ?? null,
          sshKey: remote?.ec2SshKey ?? null,
          sshSourceSecurityGroups: remote?.sourceSecurityGroups ?? [],
          sshOpenToWorld,
          autoScalingGroups: (ng.resources?.autoScalingGroups ?? []).map((a) => a.name),
        },
        derived: {},
      });
      relationships.push(
        { from: ng.nodegroupArn, to: regionArn(ctx.accountId, region), type: "IN_REGION" },
        { from: ng.nodegroupArn, to: clusterArn, type: "IN_CLUSTER" },
      );
      if (ng.nodeRole) {
        relationships.push({ from: ng.nodegroupArn, to: ng.nodeRole, type: "EXECUTES_AS" });
      }
      for (const subnet of ng.subnets ?? []) {
        relationships.push({
          from: ng.nodegroupArn,
          to: ec2Arn(region, ctx.accountId, "subnet", subnet),
          type: "IN_SUBNET",
        });
      }
    }
  }
}

/**
 * EKS Pod Identity: the newer way to give a service account a role, recorded
 * on the cluster rather than in the role's trust policy - so it is read here,
 * and joins the IRSA analyser's edges as the same `CAN_ASSUME`. Best effort:
 * clusters and regions predating it refuse the call, and so does moto.
 */
async function podIdentityGrants(
  client: EKSClient,
  clusterArn: string,
  clusterName: string,
): Promise<Relationship[]> {
  const grants: Relationship[] = [];
  try {
    for await (const page of paginateListPodIdentityAssociations({ client }, { clusterName })) {
      for (const summary of page.associations ?? []) {
        if (!summary.associationId) continue;
        const { association } = await client.send(
          new DescribePodIdentityAssociationCommand({
            clusterName,
            associationId: summary.associationId,
          }),
        );
        if (!association?.roleArn) continue;
        const account = `${association.namespace ?? "?"}/${association.serviceAccount ?? "?"}`;
        grants.push({
          from: clusterArn,
          to: association.roleArn,
          type: "CAN_ASSUME",
          properties: {
            via: "Pod Identity",
            serviceAccounts: [account],
            reason: `Pods running as ${account} in ${clusterName} are given this role by an EKS Pod Identity association`,
          },
        });
      }
    }
  } catch (err) {
    console.warn(
      `  eks: Pod Identity associations not read for ${clusterName} - ${errorMessage(err)}`,
    );
  }
  return grants;
}
