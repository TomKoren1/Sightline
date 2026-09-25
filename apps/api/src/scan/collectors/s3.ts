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
  ListBucketsCommand,
  GetBucketLocationCommand,
  GetBucketPolicyCommand,
  GetBucketPolicyStatusCommand,
  GetPublicAccessBlockCommand,
  GetBucketAclCommand,
  GetBucketTaggingCommand,
} from "@aws-sdk/client-s3";
import type { Relationship, Resource } from "@daveio/shared";

import { s3Client } from "../../aws/clients.js";
import { regionArn, s3Arn, tagsToRecord } from "../../aws/arns.js";
import { cfg } from "../../config.js";
import type { CollectorContext, CollectorOutput } from "./types.js";

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
    console.warn(`  s3: unexpected ${name || "error"} - ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

export async function collectS3(ctx: CollectorContext): Promise<CollectorOutput> {
  const home = s3Client(cfg.AWS_REGION);
  const resources: Resource[] = [];
  const relationships: Relationship[] = [];

  const listed = await home.send(new ListBucketsCommand({}));

  for (const bucket of listed.Buckets ?? []) {
    if (!bucket.Name) continue;
    const name = bucket.Name;

    // A bucket must be addressed in its own region for most calls to work.
    const location = await optional(
      () => home.send(new GetBucketLocationCommand({ Bucket: name })),
      ["NoSuchBucket"],
    );
    // us-east-1 is represented as an absent constraint, for historical reasons.
    const region = location?.LocationConstraint ?? "us-east-1";
    const client = s3Client(region);

    const [policy, policyStatus, publicAccessBlock, acl, tagging] = await Promise.all([
      optional(() => client.send(new GetBucketPolicyCommand({ Bucket: name })), [
        "NoSuchBucketPolicy",
      ]),
      optional(() => client.send(new GetBucketPolicyStatusCommand({ Bucket: name })), [
        "NoSuchBucketPolicy",
        "NoSuchBucketPolicyStatus",
      ]),
      optional(() => client.send(new GetPublicAccessBlockCommand({ Bucket: name })), [
        "NoSuchPublicAccessBlockConfiguration",
      ]),
      optional(() => client.send(new GetBucketAclCommand({ Bucket: name })), ["AccessDenied"]),
      optional(() => client.send(new GetBucketTaggingCommand({ Bucket: name })), ["NoSuchTagSet"]),
    ]);

    const arn = s3Arn(name);
    const tags = tagsToRecord(tagging?.TagSet);

    resources.push({
      arn,
      kind: "S3Bucket",
      name,
      region,
      accountId: ctx.accountId,
      tags,
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
    });
    relationships.push({ from: arn, to: regionArn(ctx.accountId, region), type: "IN_REGION" });
  }

  return { resources, relationships };
}
