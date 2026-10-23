/**
 * SQS queues and SNS topics, with the resource policies that decide who can
 * send, receive or subscribe. Whether a policy makes one public is the
 * resource-policy analyser's call; this records the document verbatim.
 */

import { GetQueueAttributesCommand, paginateListQueues } from "@aws-sdk/client-sqs";
import { GetTopicAttributesCommand, paginateListTopics } from "@aws-sdk/client-sns";
import type { Relationship, Resource } from "@sightline/shared";

import { snsClient, sqsClient } from "../../aws/clients.js";
import { regionArn } from "../../aws/arns.js";
import type { CollectorContext, CollectorOutput } from "./types.js";

export async function collectSqs(ctx: CollectorContext): Promise<CollectorOutput> {
  const region = ctx.region!;
  const client = sqsClient(ctx, region);
  const resources: Resource[] = [];
  const relationships: Relationship[] = [];

  for await (const page of paginateListQueues({ client }, {})) {
    for (const url of page.QueueUrls ?? []) {
      const { Attributes: a = {} } = await client.send(
        new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ["All"] }),
      );
      const arn = a["QueueArn"];
      if (!arn) continue;
      resources.push({
        arn,
        kind: "SqsQueue",
        name: arn.split(":").pop() ?? url,
        region,
        accountId: ctx.accountId,
        tags: {},
        properties: {
          url,
          policy: a["Policy"] ?? null,
          kmsKeyId: a["KmsMasterKeyId"] ?? null,
          encrypted: Boolean(a["KmsMasterKeyId"]) || a["SqsManagedSseEnabled"] === "true",
          fifo: a["FifoQueue"] === "true",
        },
        derived: {},
      });
      relationships.push({ from: arn, to: regionArn(ctx.accountId, region), type: "IN_REGION" });
    }
  }
  return { resources, relationships };
}

export async function collectSns(ctx: CollectorContext): Promise<CollectorOutput> {
  const region = ctx.region!;
  const client = snsClient(ctx, region);
  const resources: Resource[] = [];
  const relationships: Relationship[] = [];

  for await (const page of paginateListTopics({ client }, {})) {
    for (const topic of page.Topics ?? []) {
      if (!topic.TopicArn) continue;
      const { Attributes: a = {} } = await client.send(
        new GetTopicAttributesCommand({ TopicArn: topic.TopicArn }),
      );
      resources.push({
        arn: topic.TopicArn,
        kind: "SnsTopic",
        name: topic.TopicArn.split(":").pop() ?? topic.TopicArn,
        region,
        accountId: ctx.accountId,
        tags: {},
        properties: {
          policy: a["Policy"] ?? null,
          kmsKeyId: a["KmsMasterKeyId"] ?? null,
          encrypted: Boolean(a["KmsMasterKeyId"]),
          subscriptionsConfirmed: Number(a["SubscriptionsConfirmed"] ?? 0),
        },
        derived: {},
      });
      relationships.push({
        from: topic.TopicArn,
        to: regionArn(ctx.accountId, region),
        type: "IN_REGION",
      });
    }
  }
  return { resources, relationships };
}
