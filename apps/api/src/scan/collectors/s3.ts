/**
 * S3 buckets.
 *
 * The bucket namespace is global, so this collector runs once rather than per
 * region, and resolves each bucket's home region individually.
 *
 * Deciding whether a bucket is public needs four separate API calls per
 * bucket, and three of them routinely fail in a way that is *not* an error:
 * a bucket with no policy answers `NoSuchBucketPolicy`, one with no public
 * access block answers `NoSuchPublicAccessBlockConfiguration`, and one with no
 * tags answers `NoSuchTagSet`. Each is caught individually so that one bucket
 * missing a policy never costs us the rest of the inventory.
 */

import {
  paginateListBuckets,
  GetBucketLocationCommand,
  GetBucketPolicyCommand,
  GetBucketPolicyStatusCommand,
  GetPublicAccessBlockCommand,
  GetBucketAclCommand,
  GetBucketTaggingCommand,
  type Bucket,
  type S3Client,
} from "@aws-sdk/client-s3";
import type { Relationship, Resource } from "@sightline/shared";

import { s3Client } from "../../aws/clients.js";
import { regionArn, s3Arn, tagsToRecord } from "../../aws/arns.js";
import { cfg } from "../../core/config.js";
import { runWithConcurrency } from "../limiter.js";
import type { CollectorContext, CollectorOutput } from "./types.js";
import { errorMessage } from "@sightline/shared";

/**
 * Run a call that is allowed to come back empty.
 *
 * "This bucket has no policy" arrives as an exception, and treating it as a
 * failure would make every well-configured bucket look broken.
 */
async function optional<T>(fn: () => Promise<T>, expectedErrors: string[]): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (expectedErrors.includes(name)) return null;
    // An unexpected error is worth knowing about, but must not abort the
    // bucket: an AccessDenied on one call still leaves the rest usable.
    console.warn(`  s3: unexpected ${name || "error"} - ${errorMessage(err)}`);
    return null;
  }
}

/**
 * Buckets described at once. Each takes up to six calls, so a sequential loop
 * over 5,000 buckets is 30,000 round trips end to end; the adaptive retry in
 * the client absorbs the throttling this invites.
 */
const BUCKET_CONCURRENCY = 8;

export async function collectS3(ctx: CollectorContext): Promise<CollectorOutput> {
  const home = s3Client(ctx, cfg.AWS_REGION);

  const buckets: Bucket[] = [];
  // `MaxBuckets` opts into the paginated listing; without it the call is the
  // legacy one, which has no continuation token.
  for await (const page of paginateListBuckets({ client: home }, { MaxBuckets: 1000 })) {
    buckets.push(...(page.Buckets ?? []));
  }

  const described = await runWithConcurrency(
    buckets.filter((b) => b.Name).map((b) => () => describeBucket(ctx, home, b)),
    BUCKET_CONCURRENCY,
  );

  return {
    resources: described.map((d) => d.resource),
    relationships: described.map((d) => d.relationship),
  };
}

async function describeBucket(
  ctx: CollectorContext,
  home: S3Client,
  bucket: Bucket,
): Promise<{ resource: Resource; relationship: Relationship }> {
  const name = bucket.Name!;

  // The listing names the region; older endpoints and moto may not, so ask.
  // us-east-1 is represented as an absent constraint, for historical reasons.
  let region = bucket.BucketRegion;
  if (!region) {
    const location = await optional(
      () => home.send(new GetBucketLocationCommand({ Bucket: name })),
      ["NoSuchBucket"],
    );
    region = location?.LocationConstraint ?? "us-east-1";
  }
  // A bucket must be addressed in its own region for most calls to work.
  const client = s3Client(ctx, region);

  const [policy, policyStatus, publicAccessBlock, acl, tagging] = await Promise.all([
    optional(
      () => client.send(new GetBucketPolicyCommand({ Bucket: name })),
      ["NoSuchBucketPolicy"],
    ),
    optional(
      () => client.send(new GetBucketPolicyStatusCommand({ Bucket: name })),
      ["NoSuchBucketPolicy", "NoSuchBucketPolicyStatus"],
    ),
    optional(
      () => client.send(new GetPublicAccessBlockCommand({ Bucket: name })),
      ["NoSuchPublicAccessBlockConfiguration"],
    ),
    optional(() => client.send(new GetBucketAclCommand({ Bucket: name })), ["AccessDenied"]),
    optional(() => client.send(new GetBucketTaggingCommand({ Bucket: name })), ["NoSuchTagSet"]),
  ]);

  const arn = s3Arn(name);
  return {
    resource: {
      arn,
      kind: "S3Bucket",
      name,
      region,
      accountId: ctx.accountId,
      tags: tagsToRecord(tagging?.TagSet),
      properties: {
        bucketName: name,
        createdAt: bucket.CreationDate?.toISOString() ?? null,
        // Kept verbatim: the public/private verdict is computed from these by
        // an analyser we can unit test, not decided here.
        policy: policy?.Policy ?? null,
        policyIsPublic: policyStatus?.PolicyStatus?.IsPublic ?? null,
        publicAccessBlock: publicAccessBlock?.PublicAccessBlockConfiguration ?? null,
        aclGrants: (acl?.Grants ?? []).map((g) => ({
          granteeType: g.Grantee?.Type ?? null,
          granteeUri: g.Grantee?.URI ?? null,
          permission: g.Permission ?? null,
        })),
      },
      derived: {},
      raw: bucket,
    },
    relationship: { from: arn, to: regionArn(ctx.accountId, region), type: "IN_REGION" },
  };
}
