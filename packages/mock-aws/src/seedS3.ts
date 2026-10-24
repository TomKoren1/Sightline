/** Buckets: public, private, and the misleading cases between. */

import {
  CreateBucketCommand,
  PutBucketPolicyCommand,
  PutBucketTaggingCommand,
  PutPublicAccessBlockCommand,
} from "@aws-sdk/client-s3";
import { s3 } from "./clients.js";
import { PROD_REGION, STAGING_REGION, TAGS } from "./topology.js";
import { log } from "./seedHelpers.js";

/**
 * S3 buckets, including the pair that makes "which buckets are public?"
 * a reasoning problem rather than a lookup.
 */
export async function seedS3() {
  const client = s3(PROD_REGION);
  const wildcardPolicy = (bucket: string) =>
    JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "PublicRead",
          Effect: "Allow",
          Principal: "*",
          Action: "s3:GetObject",
          Resource: `arn:aws:s3:::${bucket}/*`,
        },
      ],
    });

  // Genuinely public: wildcard policy, and nothing blocking it.
  await client.send(new CreateBucketCommand({ Bucket: "northwind-public-assets" }));
  await client.send(
    new PutBucketPolicyCommand({
      Bucket: "northwind-public-assets",
      Policy: wildcardPolicy("northwind-public-assets"),
    }),
  );
  await client.send(
    new PutPublicAccessBlockCommand({
      Bucket: "northwind-public-assets",
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: false,
        IgnorePublicAcls: false,
        BlockPublicPolicy: false,
        RestrictPublicBuckets: false,
      },
    }),
  );
  await client.send(
    new PutBucketTaggingCommand({
      Bucket: "northwind-public-assets",
      Tagging: { TagSet: Object.entries(TAGS.prod).map(([Key, Value]) => ({ Key, Value })) },
    }),
  );

  // The trap: identical wildcard policy, but RestrictPublicBuckets neutralises
  // it. Reading the policy alone gives the wrong answer.
  await client.send(new CreateBucketCommand({ Bucket: "northwind-reports" }));
  await client.send(
    new PutBucketPolicyCommand({
      Bucket: "northwind-reports",
      Policy: wildcardPolicy("northwind-reports"),
    }),
  );
  await client.send(
    new PutPublicAccessBlockCommand({
      Bucket: "northwind-reports",
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true,
      },
    }),
  );

  await client.send(new CreateBucketCommand({ Bucket: "northwind-terraform-state" }));
  await client.send(
    new PutPublicAccessBlockCommand({
      Bucket: "northwind-terraform-state",
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true,
      },
    }),
  );

  // Private, but nothing has written to it in a long time - an idle cost.
  await client.send(new CreateBucketCommand({ Bucket: "northwind-logs-archive" }));
  await client.send(
    new PutBucketTaggingCommand({
      Bucket: "northwind-logs-archive",
      Tagging: {
        TagSet: [
          { Key: "Environment", Value: "legacy" },
          { Key: "LastReviewed", Value: "2022-03-01" },
        ],
      },
    }),
  );

  const staging = s3(STAGING_REGION);
  await staging.send(
    new CreateBucketCommand({
      Bucket: "northwind-staging-uploads",
      CreateBucketConfiguration: { LocationConstraint: STAGING_REGION },
    }),
  );

  log("S3: 5 buckets (1 public, 1 wildcard-policy-but-blocked, 1 idle)");
}
