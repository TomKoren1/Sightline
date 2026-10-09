/**
 * Is an S3 bucket reachable by an anonymous principal? Four inputs interact:
 * the bucket policy, its ACL, its public access block, and the account's.
 *
 * A wildcard-principal policy is NOT public under `RestrictPublicBuckets`, and
 * a public ACL is NOT public under `IgnorePublicAcls`. The mock holds two
 * buckets with byte-identical policies where exactly one is effectively public,
 * so reading only the policy is visibly wrong.
 *
 * The account-level block overrides all of this and is not read - that needs
 * `s3control:GetPublicAccessBlock`. So this can only be too cautious in the
 * "public" direction, never too permissive.
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
  /**
   * True when nothing would stop this bucket being made public.
   *
   * Independent of `isPublic`. A bucket can be unprotected and entirely
   * private, which is the common case and the one that confuses people: turning
   * Block Public Access off grants nobody anything, it only removes the setting
   * that would neutralise a permissive policy if one were ever added.
   */
  isUnprotected: boolean;
  unprotectedReason?: string;
}

/**
 * Which of the four Block Public Access settings are switched off.
 *
 * An absent configuration counts as all four off, because that is what it
 * means: buckets created before the account-level default, or with it
 * explicitly cleared, have no bucket-level block at all.
 */
export function disabledBlockSettings(pab: PublicAccessBlock | null): string[] {
  const settings: [keyof PublicAccessBlock, string][] = [
    ["BlockPublicAcls", "BlockPublicAcls"],
    ["IgnorePublicAcls", "IgnorePublicAcls"],
    ["BlockPublicPolicy", "BlockPublicPolicy"],
    ["RestrictPublicBuckets", "RestrictPublicBuckets"],
  ];
  return settings.filter(([key]) => pab?.[key] !== true).map(([, label]) => label);
}

/** Does a policy document allow a wildcard principal? */
export function policyAllowsWildcardPrincipal(policyJson: string | null): boolean {
  if (!policyJson) return false;
  try {
    const doc = JSON.parse(policyJson) as {
      Statement?: {
        Effect?: string;
        Principal?: unknown;
        Condition?: Record<string, unknown>;
      }[];
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

  const disabled = disabledBlockSettings(pab);
  const protection =
    disabled.length === 0
      ? { isUnprotected: false as const }
      : {
          isUnprotected: true as const,
          unprotectedReason:
            disabled.length === 4
              ? "Block Public Access is entirely off for this bucket, so a policy or ACL granting anonymous access would take effect immediately. The bucket is not public today - this is a missing guardrail, not exposure."
              : `Block Public Access is partially off (${disabled.join(", ")} not enabled), so some routes to making this bucket public are unguarded. The bucket is not public today - this is a missing guardrail, not exposure.`,
        };

  const publicAcl = input.aclGrants.find(
    (g) => g.granteeUri === ALL_USERS || g.granteeUri === AUTHENTICATED_USERS,
  );
  // Prefer AWS's own policy status when we have it; fall back to parsing.
  const wildcardPolicy = input.policyIsPublic ?? policyAllowsWildcardPrincipal(input.policy);

  const policyRestricted = pab?.RestrictPublicBuckets === true || pab?.BlockPublicPolicy === true;
  const aclRestricted = pab?.IgnorePublicAcls === true || pab?.BlockPublicAcls === true;

  if (wildcardPolicy && !policyRestricted) {
    return {
      ...protection,
      isPublic: true,
      reason:
        'Its bucket policy allows a wildcard principal ("*") and no public access block restricts policy-based access',
    };
  }

  if (publicAcl && !aclRestricted) {
    const who = publicAcl.granteeUri === ALL_USERS ? "AllUsers (anonymous)" : "AuthenticatedUsers";
    return {
      ...protection,
      isPublic: true,
      reason: `Its ACL grants ${publicAcl.permission ?? "access"} to ${who} and no public access block ignores public ACLs`,
    };
  }

  if (wildcardPolicy && policyRestricted) {
    const setting = pab?.RestrictPublicBuckets ? "RestrictPublicBuckets" : "BlockPublicPolicy";
    return {
      ...protection,
      isPublic: false,
      reason: `Its bucket policy allows a wildcard principal, but ${setting} is enabled, so the grant has no effect`,
    };
  }

  if (publicAcl && aclRestricted) {
    return {
      ...protection,
      isPublic: false,
      reason: "Its ACL grants public access, but the public access block ignores public ACLs",
    };
  }

  return {
    ...protection,
    isPublic: false,
    reason: "No bucket policy or ACL grants access to an anonymous or wildcard principal",
  };
}
