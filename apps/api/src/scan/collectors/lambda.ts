/**
 * Lambda functions.
 *
 * The execution role is the interesting edge here: a function inherits every
 * permission of the role it runs as, so a trivial image-resizer attached to an
 * administrator role is a genuine privilege-escalation path. `EXECUTES_AS`
 * carries that into the graph.
 */

import { paginateListFunctions } from "@aws-sdk/client-lambda";
import type { Relationship, Resource } from "@sightline/shared";

import { lambdaClient } from "../../aws/clients.js";
import { ec2Arn, lambdaArn, regionArn } from "../../aws/arns.js";
import type { CollectorContext, CollectorOutput } from "./types.js";

export async function collectLambda(ctx: CollectorContext): Promise<CollectorOutput> {
  const region = ctx.region!;
  const client = lambdaClient(region);
  const resources: Resource[] = [];
  const relationships: Relationship[] = [];

  for await (const page of paginateListFunctions({ client }, {})) {
    for (const fn of page.Functions ?? []) {
      if (!fn.FunctionName) continue;
      const arn = fn.FunctionArn ?? lambdaArn(region, ctx.accountId, fn.FunctionName);

      resources.push({
        arn,
        kind: "LambdaFunction",
        name: fn.FunctionName,
        region,
        accountId: ctx.accountId,
        tags: {},
        properties: {
          functionName: fn.FunctionName,
          runtime: fn.Runtime ?? null,
          handler: fn.Handler ?? null,
          roleArn: fn.Role ?? null,
          memorySizeMb: fn.MemorySize ?? null,
          timeoutSeconds: fn.Timeout ?? null,
          lastModified: fn.LastModified ?? null,
          codeSizeBytes: fn.CodeSize ?? 0,
          vpcId: fn.VpcConfig?.VpcId ?? null,
          subnetIds: fn.VpcConfig?.SubnetIds ?? [],
          securityGroupIds: fn.VpcConfig?.SecurityGroupIds ?? [],
        },
        derived: {},
        raw: fn,
      });
      relationships.push({ from: arn, to: regionArn(ctx.accountId, region), type: "IN_REGION" });

      if (fn.Role) {
        relationships.push({ from: arn, to: fn.Role, type: "EXECUTES_AS" });
      }
      for (const subnetId of fn.VpcConfig?.SubnetIds ?? []) {
        relationships.push({
          from: arn,
          to: ec2Arn(region, ctx.accountId, "subnet", subnetId),
          type: "IN_SUBNET",
        });
      }
      for (const sgId of fn.VpcConfig?.SecurityGroupIds ?? []) {
        relationships.push({
          from: arn,
          to: ec2Arn(region, ctx.accountId, "security-group", sgId),
          type: "HAS_SECURITY_GROUP",
        });
      }
    }
  }

  return { resources, relationships };
}
