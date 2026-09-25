/**
 * The domain model shared by the scanner, the graph projection, the agent and
 * the frontend.
 *
 * Design note
 * -----------
 * The single most important decision in this codebase lives here: the
 * `derived` block on `Resource`, and the `CAN_REACH` relationship.
 *
 * Questions like "which buckets are public?" or "what can reach the production
 * database?" are *security reasoning*, not data lookup. Answering them requires
 * combining a bucket policy with its ACLs and its public-access block, or
 * walking a chain of security-group references. That reasoning is done
 * deterministically, in code, at projection time - never by the language model.
 *
 * The LLM's job is to select the right query, read facts that were computed by
 * code, and explain them. It is not asked to evaluate an IAM policy document in
 * its head. This is what makes the agent's answers auditable: every claim it
 * makes traces back to a deterministic function we can unit-test.
 */

/** Every kind of node that can appear in the resource graph. */
export const RESOURCE_KINDS = [
  "Account",
  "Region",
  "Vpc",
  "Subnet",
  "SecurityGroup",
  "InternetGateway",
  "NatGateway",
  "RouteTable",
  "Ec2Instance",
  "EbsVolume",
  "ElasticIp",
  "S3Bucket",
  "IamRole",
  "IamUser",
  "IamPolicy",
  "InstanceProfile",
  "RdsInstance",
  "DbSubnetGroup",
  "LambdaFunction",
  "Internet",
] as const;

export type ResourceKind = (typeof RESOURCE_KINDS)[number];

/** Relationship types in the graph. */
export const RELATIONSHIP_TYPES = [
  "IN_REGION",
  "IN_VPC",
  "IN_SUBNET",
  "HAS_SECURITY_GROUP",
  "ATTACHED_TO",
  "ROUTES_TO",
  "USES_SUBNET_GROUP",
  "HAS_INSTANCE_PROFILE",
  "PROVIDES_ROLE",
  "HAS_POLICY",
  "CAN_ASSUME",
  "EXECUTES_AS",
  /**
   * Derived, not observed. Computed by the reachability analyser from security
   * group rules, subnet routing and public-accessibility flags. Carries the
   * ports and the evidence that justified it.
   */
  "CAN_REACH",
] as const;

export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

/**
 * Facts computed by analysers rather than read from an AWS API field.
 *
 * Each flag is paired with a human-readable `reason` carrying the evidence.
 * The agent is instructed to quote the reason, so a DevOps engineer sees *why*
 * something was flagged and can disagree with it.
 */
export interface DerivedFacts {
  /** Reachable from the public internet. */
  isPublic?: boolean;
  publicReason?: string;

  /** Grants effective `*:*`, via any combination of managed and inline policy. */
  isAdmin?: boolean;
  adminReason?: string;

  /** Provisioned and billable but showing no sign of use. */
  isIdle?: boolean;
  idleReason?: string;

  /** Rough monthly USD, for the "costing money but not used" question. */
  estimatedMonthlyCostUsd?: number;
}

/** A single AWS resource, normalised. `arn` is the canonical identity. */
export interface Resource {
  arn: string;
  kind: ResourceKind;
  name: string;
  /** `null` for global services such as IAM and S3's bucket namespace. */
  region: string | null;
  accountId: string;
  tags: Record<string, string>;
  /** Normalised, queryable subset of the resource's attributes. */
  properties: Record<string, unknown>;
  derived: DerivedFacts;
  /** Verbatim API response, kept so we can re-derive without a rescan. */
  raw?: unknown;
}

export interface Relationship {
  /** ARN of the source node. */
  from: string;
  /** ARN of the target node. */
  to: string;
  type: RelationshipType;
  properties?: Record<string, unknown>;
}

/** Synthetic node representing the public internet, used as a path source. */
export const INTERNET_ARN = "arn:aws:daveio:::internet";

/** A port range opened by a security group rule. */
export interface PortRange {
  protocol: string;
  fromPort: number | null;
  toPort: number | null;
}

export function formatPortRange(p: PortRange): string {
  if (p.protocol === "-1") return "all traffic";
  if (p.fromPort === null || p.toPort === null) return p.protocol;
  if (p.fromPort === p.toPort) return `${p.protocol}/${p.fromPort}`;
  return `${p.protocol}/${p.fromPort}-${p.toPort}`;
}

/** True for services whose resources are not scoped to a region. */
export function isGlobalKind(kind: ResourceKind): boolean {
  return (
    kind === "Account" ||
    kind === "IamRole" ||
    kind === "IamUser" ||
    kind === "IamPolicy" ||
    kind === "InstanceProfile" ||
    kind === "Internet"
  );
}
