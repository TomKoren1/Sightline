/**
 * DynamoDB tables: encryption, point-in-time recovery and size. The role
 * denies reading items; a table's configuration is all that is collected.
 */

import {
  DescribeContinuousBackupsCommand,
  DescribeTableCommand,
  paginateListTables,
} from "@aws-sdk/client-dynamodb";
import type { Relationship, Resource } from "@sightline/shared";

import { dynamodbClient } from "../../aws/clients.js";
import { regionArn } from "../../aws/arns.js";
import type { CollectorContext, CollectorOutput } from "./types.js";

export async function collectDynamoDb(ctx: CollectorContext): Promise<CollectorOutput> {
  const region = ctx.region!;
  const client = dynamodbClient(ctx, region);
  const resources: Resource[] = [];
  const relationships: Relationship[] = [];

  for await (const page of paginateListTables({ client }, {})) {
    for (const name of page.TableNames ?? []) {
      const [{ Table: table }, backups] = await Promise.all([
        client.send(new DescribeTableCommand({ TableName: name })),
        client.send(new DescribeContinuousBackupsCommand({ TableName: name })).catch(() => null),
      ]);
      if (!table?.TableArn) continue;
      const pitr =
        backups?.ContinuousBackupsDescription?.PointInTimeRecoveryDescription
          ?.PointInTimeRecoveryStatus;
      resources.push({
        arn: table.TableArn,
        kind: "DynamoTable",
        name,
        region,
        accountId: ctx.accountId,
        tags: {},
        properties: {
          status: table.TableStatus ?? null,
          itemCount: table.ItemCount ?? null,
          sizeBytes: table.TableSizeBytes ?? null,
          billingMode: table.BillingModeSummary?.BillingMode ?? "PROVISIONED",
          // No SSEDescription means AWS-owned encryption, which is still encryption.
          encryption: table.SSEDescription?.SSEType ?? "AWS_OWNED",
          pointInTimeRecovery: pitr === "ENABLED",
          deletionProtection: table.DeletionProtectionEnabled ?? false,
        },
        derived: {},
      });
      relationships.push({
        from: table.TableArn,
        to: regionArn(ctx.accountId, region),
        type: "IN_REGION",
      });
    }
  }
  return { resources, relationships };
}
