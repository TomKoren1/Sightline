import { describe, expect, it } from "vitest";
import { evaluateBucketPublicAccess, policyAllowsWildcardPrincipal } from "./publicAccess.js";

const wildcardPolicy = JSON.stringify({
  Version: "2012-10-17",
  Statement: [
    { Effect: "Allow", Principal: "*", Action: "s3:GetObject", Resource: "arn:aws:s3:::b/*" },
  ],
});

const base = {
  bucketName: "b",
  policy: null,
  policyIsPublic: null,
  publicAccessBlock: null,
  aclGrants: [],
};

const ALL_USERS = "http://acs.amazonaws.com/groups/global/AllUsers";

describe("policyAllowsWildcardPrincipal", () => {
  it("detects a bare wildcard principal", () => {
    expect(policyAllowsWildcardPrincipal(wildcardPolicy)).toBe(true);
  });

  it("detects a wildcard inside Principal.AWS", () => {
    expect(
      policyAllowsWildcardPrincipal(
        JSON.stringify({ Statement: [{ Effect: "Allow", Principal: { AWS: ["*"] } }] }),
      ),
    ).toBe(true);
  });

  it("does not flag a named account principal", () => {
    expect(
      policyAllowsWildcardPrincipal(
        JSON.stringify({
          Statement: [{ Effect: "Allow", Principal: { AWS: "arn:aws:iam::123456789012:root" } }],
        }),
      ),
    ).toBe(false);
  });

  it("does not flag a wildcard principal that a condition scopes down", () => {
    expect(
      policyAllowsWildcardPrincipal(
        JSON.stringify({
          Statement: [
            {
              Effect: "Allow",
              Principal: "*",
              Condition: { StringEquals: { "aws:SourceVpce": "vpce-1" } },
            },
          ],
        }),
      ),
    ).toBe(false);
  });

  it("treats absent or malformed policy as not public", () => {
    expect(policyAllowsWildcardPrincipal(null)).toBe(false);
    expect(policyAllowsWildcardPrincipal("not json")).toBe(false);
  });
});

describe("evaluateBucketPublicAccess", () => {
  it("calls a wildcard-policy bucket public when nothing blocks it", () => {
    const v = evaluateBucketPublicAccess({ ...base, policy: wildcardPolicy });
    expect(v.isPublic).toBe(true);
    expect(v.reason).toContain("wildcard principal");
  });

  /**
   * The pair that matters: identical policies, opposite verdicts. This is the
   * case an implementation that reads only the policy gets wrong.
   */
  it("calls an identical bucket private when RestrictPublicBuckets is set", () => {
    const v = evaluateBucketPublicAccess({
      ...base,
      policy: wildcardPolicy,
      publicAccessBlock: { RestrictPublicBuckets: true },
    });
    expect(v.isPublic).toBe(false);
    expect(v.reason).toContain("RestrictPublicBuckets");
  });

  it("respects BlockPublicPolicy as well", () => {
    const v = evaluateBucketPublicAccess({
      ...base,
      policy: wildcardPolicy,
      publicAccessBlock: { BlockPublicPolicy: true },
    });
    expect(v.isPublic).toBe(false);
    expect(v.reason).toContain("BlockPublicPolicy");
  });

  it("prefers AWS's own policy status over parsing the document ourselves", () => {
    // Policy text says nothing public, but AWS says it is - trust AWS.
    const v = evaluateBucketPublicAccess({ ...base, policy: "{}", policyIsPublic: true });
    expect(v.isPublic).toBe(true);
  });

  it("flags a bucket public via an AllUsers ACL grant", () => {
    const v = evaluateBucketPublicAccess({
      ...base,
      aclGrants: [{ granteeType: "Group", granteeUri: ALL_USERS, permission: "READ" }],
    });
    expect(v.isPublic).toBe(true);
    expect(v.reason).toContain("AllUsers");
  });

  it("does not flag a public ACL that IgnorePublicAcls neutralises", () => {
    const v = evaluateBucketPublicAccess({
      ...base,
      aclGrants: [{ granteeType: "Group", granteeUri: ALL_USERS, permission: "READ" }],
      publicAccessBlock: { IgnorePublicAcls: true },
    });
    expect(v.isPublic).toBe(false);
  });

  it("ignores ordinary owner grants", () => {
    const v = evaluateBucketPublicAccess({
      ...base,
      aclGrants: [{ granteeType: "CanonicalUser", granteeUri: null, permission: "FULL_CONTROL" }],
    });
    expect(v.isPublic).toBe(false);
  });

  it("always explains itself", () => {
    expect(evaluateBucketPublicAccess(base).reason.length).toBeGreaterThan(0);
  });
});
