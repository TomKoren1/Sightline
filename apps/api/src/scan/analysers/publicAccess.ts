/**
 * Is an S3 bucket reachable by an anonymous principal?
 *
 * This is the question the brief opens with, and it is a good example of why
 * the model is not allowed to answer it. Four inputs interact:
 *
 *   1. the bucket policy - does it allow a wildcard principal?
 *   2. the bucket ACL - does it grant to AllUsers or AuthenticatedUsers?
 *   3. the bucket's public access block
 *   4. the account's public access block (not read here; see the caveat below)
 *
 * A bucket with a wildcard-principal policy is NOT public if
 * `RestrictPublicBuckets` is set, and a bucket with a public ACL is NOT public
 * if `IgnorePublicAcls` is set. The mock account contains two buckets with
 * byte-identical policies where exactly one is effectively public, so any
 * implementation that reads only the policy is visibly wrong.
 *
 * Caveat, stated rather than hidden: the account-level public access block
 * overrides all of this and is not read, because doing so needs
 * `s3control:GetPublicAccessBlock` against the account id. Where it is set,
 * this analyser can only be too cautious in the "public" direction, never too
 * permissive - it may call a bucket public that the account level blocks.
 */

const ALL_USERS = "http://acs.amazonaws.com/groups/global/AllUsers";
const AUTHENTICATED_USERS = "http://acs.amazonaws.com/groups/global/AuthenticatedUsers";

export interface PublicAccessBlock {
  BlockPublicAcls?: boolean;
  IgnorePublicAcls?: boolean;
  BlockPublicPolicy?: boolean;
  RestrictPublicBuckets?: boolean;
}

export interface AclGrant {
  granteeType: string | null;
  granteeUri: string | null;
  permission: string | null;
}

export interface BucketPublicInput {
  bucketName: string;
  /** Raw policy JSON, as returned by GetBucketPolicy. */
  policy: string | null;
  /** AWS's own verdict from GetBucketPolicyStatus, when available. */
  policyIsPublic: boolean | null;
  publicAccessBlock: PublicAccessBlock | null;
  aclGrants: AclGrant[];
}

export interface PublicVerdict {
  isPublic: boolean;
  reason: string;
}

/** Does a policy document allow a wildcard principal? */
export function policyAllowsWildcardPrincipal(policyJson: string | null): boolean {
  if (!policyJson) return false;
  try {
    const doc = JSON.parse(policyJson) as {
      Statement?: Array<{
        Effect?: string;
        Principal?: unknown;
        Condition?: Record<string, unknown>;
      }>;
    };
    for (const stmt of doc.Statement ?? []) {
      if (stmt.Effect !== "Allow") continue;
      // A condition can scope a wildcard principal down to something safe
      // (a VPC endpoint, a source account), so it is not counted as public.
      if (stmt.Condition && Object.keys(stmt.Condition).length > 0) continue;
      const principal = stmt.Principal;
      if (principal === "*") return true;
      if (typeof principal === "object" && principal !== null) {
        const aws = (principal as { AWS?: string | string[] }).AWS;
        const values = aws === undefined ? [] : Array.isArray(aws) ? aws : [aws];
        if (values.includes("*")) return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

export function evaluateBucketPublicAccess(input: BucketPublicInput): PublicVerdict {
  const pab = input.publicAccessBlock;

  const publicAcl = input.aclGrants.find(
    (g) => g.granteeUri === ALL_USERS || g.granteeUri === AUTHENTICATED_USERS,
  );
  // Prefer AWS's own policy status when we have it; fall back to parsing.
  const wildcardPolicy =
    input.policyIsPublic ?? policyAllowsWildcardPrincipal(input.policy);

  const policyRestricted = pab?.RestrictPublicBuckets === true || pab?.BlockPublicPolicy === true;
  const aclRestricted = pab?.IgnorePublicAcls === true || pab?.BlockPublicAcls === true;

  if (wildcardPolicy && !policyRestricted) {
    return {
      isPublic: true,
      reason:
        "Its bucket policy allows a wildcard principal (\"*\") and no public access block restricts policy-based access",
    };
  }

  if (publicAcl && !aclRestricted) {
    const who = publicAcl.granteeUri === ALL_USERS ? "AllUsers (anonymous)" : "AuthenticatedUsers";
    return {
      isPublic: true,
      reason: `Its ACL grants ${publicAcl.permission ?? "access"} to ${who} and no public access block ignores public ACLs`,
    };
  }

  if (wildcardPolicy && policyRestricted) {
    const setting = pab?.RestrictPublicBuckets ? "RestrictPublicBuckets" : "BlockPublicPolicy";
    return {
      isPublic: false,
      reason: `Its bucket policy allows a wildcard principal, but ${setting} is enabled, so the grant has no effect`,
    };
  }

  if (publicAcl && aclRestricted) {
    return {
      isPublic: false,
      reason: "Its ACL grants public access, but the public access block ignores public ACLs",
    };
  }

  return {
    isPublic: false,
    reason: "No bucket policy or ACL grants access to an anonymous or wildcard principal",
  };
}
