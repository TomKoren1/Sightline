/**
 * The domain model shared by the scanner, the graph, the agent and the frontend.
 *
 * The most important decision in this codebase lives here: the `derived` block
 * on `Resource`, and the `CAN_REACH` relationship. "Which buckets are public?"
 * is security reasoning, not a lookup - it means combining a policy with its
 * ACLs and access block - and that reasoning happens deterministically in code
 * at ingest time, never in the model.
 *
 * The model selects the query, reads computed facts and explains them. That is
 * what makes its answers auditable: every claim traces to a unit-tested
 * function.
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
  "NetworkAcl",
  "VpcPeeringConnection",
  "TransitGateway",
  "VpcEndpoint",
  "VpcEndpointService",
  "LoadBalancer",
  "TargetGroup",
  "CloudFrontDistribution",
  "ApiGateway",
  "HostedZone",
  "Ec2Instance",
  "AutoScalingGroup",
  "EcsCluster",
  "EcsService",
  "EksCluster",
  "EbsVolume",
  "ElasticIp",
  "S3Bucket",
  "IamRole",
  "IamUser",
  "IamGroup",
  "IamPolicy",
  "InstanceProfile",
  "RdsInstance",
  "DbSubnetGroup",
  "LambdaFunction",
  "SqsQueue",
  "SnsTopic",
  "KmsKey",
  "Secret",
  "DynamoTable",
  "Internet",
] as const;

export type ResourceKind = (typeof RESOURCE_KINDS)[number];

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
  "MEMBER_OF",
  /** Subnet -> the network ACL that filters its traffic. */
  "HAS_NACL",
  /** Subnet -> the route table that decides where its traffic goes, explicit or main. */
  "USES_ROUTE_TABLE",
  /** Peering connection -> each of the two VPCs it joins. */
  "PEERS_WITH",
  /** Interface endpoint -> the PrivateLink service it connects to. */
  "CONNECTS_TO",
  /** PrivateLink service -> the network load balancer behind it. */
  "SERVED_BY",
  /** Load balancer -> a target group a listener forwards to. */
  "FORWARDS_TO",
  /** Target group -> a registered target. */
  "TARGETS",
  /** CloudFront distribution -> the resource an origin points at. */
  "HAS_ORIGIN",
  /** API -> the backend an integration invokes. */
  "INTEGRATES_WITH",
  /** Hosted zone -> what one of its records resolves to. */
  "POINTS_TO",
  /** ECS service -> its cluster. */
  "IN_CLUSTER",
  /** Auto Scaling group -> an instance it launched. */
  "MANAGES",
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

  /**
   * Effectively an administrator: granted everything (`direct`), or able to
   * grant itself everything through a known escalation path (`escalation`).
   */
  isAdmin?: boolean;
  adminVia?: "direct" | "escalation";
  adminReason?: string;

  /** Provisioned and billable but showing no sign of use. */
  isIdle?: boolean;
  idleReason?: string;

  /**
   * Nothing prevents this resource from being made public.
   *
   * Deliberately separate from `isPublic`, because they answer different
   * questions and conflating them is the most common misreading in this whole
   * area. An S3 bucket with Block Public Access switched off is **not** public:
   * it has no policy or ACL granting anonymous access, and an anonymous request
   * gets 403. What it has lost is the guardrail that would stop a future policy
   * from working.
   *
   * So this is a posture finding, not an exposure finding - worth reporting,
   * never worth reporting as "public".
   */
  isUnprotected?: boolean;
  unprotectedReason?: string;

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
export const INTERNET_ARN = "arn:aws:sightline:::internet";

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
    kind === "IamGroup" ||
    kind === "IamPolicy" ||
    kind === "CloudFrontDistribution" ||
    kind === "HostedZone" ||
    kind === "InstanceProfile" ||
    kind === "Internet"
  );
}
