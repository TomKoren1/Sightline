/**
 * Turns raw collected resources into the annotated graph the agent queries.
 *
 * Runs after collection, over the whole estate at once, because the
 * interesting facts are cross-resource: a security group rule only means
 * something in combination with the subnet its instance sits in, and an admin
 * role only matters once you know what uses it.
 */

import { INTERNET_ARN, type Relationship, type Resource, type ScanResult } from "@daveio/shared";

import { accountArn, regionArn } from "../aws/arns.js";
import { evaluateAdmin, type PolicyRef } from "./analysers/policy.js";
import {
  evaluateBucketPublicAccess,
  type AclGrant,
  type PublicAccessBlock,
} from "./analysers/publicAccess.js";
import { analyseIdleResources } from "./analysers/idle.js";
import { analyseReachability } from "./analysers/reachability.js";

/** Synthetic nodes: the account, its regions, and the internet. */
function scaffoldNodes(accountId: string, regions: string[]): Resource[] {
  const nodes: Resource[] = [
    {
      arn: accountArn(accountId),
      kind: "Account",
      name: `AWS account ${accountId}`,
      region: null,
      accountId,
      tags: {},
      properties: { accountId },
      derived: {},
    },
    {
      arn: INTERNET_ARN,
      kind: "Internet",
      name: "Public internet",
      region: null,
      accountId,
      tags: {},
      properties: {
        note: "Synthetic node. Paths starting here are reachable from outside the account.",
      },
      derived: {},
    },
  ];

  for (const region of regions) {
    nodes.push({
      arn: regionArn(accountId, region),
      kind: "Region",
      name: region,
      region,
      accountId,
      tags: {},
      properties: { region },
      derived: {},
    });
  }
  return nodes;
}

export function annotate(
  accountId: string,
  regions: string[],
  collected: { resources: Resource[]; relationships: Relationship[] },
): ScanResult {
  const resources = [...scaffoldNodes(accountId, regions), ...collected.resources];
  const relationships = [...collected.relationships];

  // Region nodes hang off the account, so the graph has a single root.
  for (const region of regions) {
    relationships.push({
      from: regionArn(accountId, region),
      to: accountArn(accountId),
      type: "IN_REGION",
    });
  }

  // --- Which principals are administrators? -------------------------------
  for (const resource of resources) {
    if (resource.kind !== "IamRole") continue;
    const attached = (resource.properties["attachedPolicies"] ?? []) as Array<{
      policyName: string;
      document: unknown;
    }>;
    const inline = (resource.properties["inlinePolicies"] ?? []) as Array<{
      policyName: string;
      document: unknown;
    }>;

    const refs: PolicyRef[] = [
      ...attached.map((p) => ({
        policyName: p.policyName,
        kind: "managed" as const,
        document: p.document as PolicyRef["document"],
      })),
      ...inline.map((p) => ({
        policyName: p.policyName,
        kind: "inline" as const,
        document: p.document as PolicyRef["document"],
      })),
    ];

    const verdict = evaluateAdmin(refs);
    resource.derived.isAdmin = verdict.isAdmin;
    resource.derived.adminReason = verdict.reason;
  }

  // --- Which buckets are actually public? ---------------------------------
  for (const resource of resources) {
    if (resource.kind !== "S3Bucket") continue;
    const verdict = evaluateBucketPublicAccess({
      bucketName: resource.name,
      policy: (resource.properties["policy"] ?? null) as string | null,
      policyIsPublic: (resource.properties["policyIsPublic"] ?? null) as boolean | null,
      publicAccessBlock: (resource.properties["publicAccessBlock"] ??
        null) as PublicAccessBlock | null,
      aclGrants: (resource.properties["aclGrants"] ?? []) as AclGrant[],
    });
    resource.derived.isPublic = verdict.isPublic;
    resource.derived.publicReason = verdict.reason;
    resource.derived.isUnprotected = verdict.isUnprotected;
    if (verdict.unprotectedReason) {
      resource.derived.unprotectedReason = verdict.unprotectedReason;
    }
  }

  // --- What is billable and doing nothing? --------------------------------
  analyseIdleResources(resources, relationships);

  // --- What can reach what? -----------------------------------------------
  const { edges, internetReachable } = analyseReachability(resources, relationships);
  relationships.push(...edges);

  // Fold reachability back onto the resources, so a node carries its own
  // verdict and the UI does not have to re-derive it from edges.
  for (const resource of resources) {
    if (resource.kind === "S3Bucket" || resource.kind === "Internet") continue;
    if (!internetReachable.has(resource.arn)) continue;
    const direct = edges.find((e) => e.from === INTERNET_ARN && e.to === resource.arn);
    resource.derived.isPublic = true;
    resource.derived.publicReason =
      (direct?.properties?.["reason"] as string | undefined) ??
      "Reachable from the internet through a chain of security group rules";
  }

  return { accountId, regions, units: [], resources, relationships };
}
