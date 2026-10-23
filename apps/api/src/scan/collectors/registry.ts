/**
 * Every collector, and what it needs.
 *
 * Adding a service is one entry here plus its collector: the `Record` refuses
 * to compile until every id in `SCANNABLE_SERVICES` has one, and the runner
 * plans its units, scopes them and explains a permission failure from these
 * fields alone.
 */

import type { RelationshipType, ResourceKind, ScannableService } from "@sightline/shared";

import { collectApiGateway } from "./apigateway.js";
import { collectCloudFront } from "./cloudfront.js";
import { collectEc2 } from "./ec2.js";
import { collectElbv2 } from "./elbv2.js";
import { collectIam } from "./iam.js";
import { collectLambda } from "./lambda.js";
import { collectRds } from "./rds.js";
import { collectS3 } from "./s3.js";
import { collectEcs, collectEks } from "./containers.js";
import { collectAutoScaling, collectRoute53 } from "./dns.js";
import { collectDynamoDb } from "./dynamodb.js";
import { collectSns, collectSqs } from "./messaging.js";
import { collectKms, collectSecrets } from "./secrets.js";
import type { Collector } from "./types.js";
import { collectVpc } from "./vpc.js";

export interface CollectorPlugin {
  /** Run once per scan, or once per region. Must agree with `GLOBAL_SERVICES`. */
  scope: "global" | "regional";
  /** What it emits. A kind no plugin claims is one nothing can produce. */
  kinds: readonly ResourceKind[];
  /** Every relationship type it may emit. Analysers add the derived ones. */
  relationships: readonly RelationshipType[];
  /**
   * An upper bound on its AWS calls in one unit: a fixed number, plus so many
   * per resource it returns (paginated lists cost a fraction a resource).
   * Checked against moto, and what a scan of N resources is estimated from.
   */
  calls: { perUnit: number; perResource: number };
  /** The read-only actions it calls, named in the error when one is refused. */
  permissions: readonly string[];
  collect: Collector;
}

export const COLLECTORS: Record<ScannableService, CollectorPlugin> = {
  ec2: {
    scope: "regional",
    relationships: [
      "ATTACHED_TO",
      "HAS_INSTANCE_PROFILE",
      "HAS_SECURITY_GROUP",
      "IN_REGION",
      "IN_SUBNET",
    ],
    calls: { perUnit: 3, perResource: 0.01 },
    kinds: ["Ec2Instance", "EbsVolume", "ElasticIp"],
    permissions: ["ec2:DescribeInstances", "ec2:DescribeVolumes", "ec2:DescribeAddresses"],
    collect: collectEc2,
  },
  vpc: {
    scope: "regional",
    relationships: [
      "ATTACHED_TO",
      "CONNECTS_TO",
      "HAS_NACL",
      "HAS_SECURITY_GROUP",
      "IN_REGION",
      "IN_SUBNET",
      "IN_VPC",
      "PEERS_WITH",
      "ROUTES_TO",
      "SERVED_BY",
      "USES_ROUTE_TABLE",
    ],
    calls: { perUnit: 14, perResource: 0.05 },
    kinds: [
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
    ],
    permissions: [
      "ec2:DescribeVpcs",
      "ec2:DescribeSubnets",
      "ec2:DescribeSecurityGroups",
      "ec2:DescribeInternetGateways",
      "ec2:DescribeNatGateways",
      "ec2:DescribeRouteTables",
      "ec2:DescribeNetworkAcls",
      "ec2:DescribeVpcPeeringConnections",
      "ec2:DescribeTransitGateways",
      "ec2:DescribeTransitGatewayAttachments",
      "ec2:DescribeTransitGatewayRouteTables",
      "ec2:SearchTransitGatewayRoutes",
      "ec2:DescribeVpcEndpoints",
      "ec2:DescribeVpcEndpointServiceConfigurations",
    ],
    collect: collectVpc,
  },
  s3: {
    scope: "global",
    relationships: ["IN_REGION"],
    calls: { perUnit: 1, perResource: 6 },
    kinds: ["S3Bucket"],
    permissions: [
      "s3:ListAllMyBuckets",
      "s3:GetBucketLocation",
      "s3:GetBucketPolicy",
      "s3:GetBucketPolicyStatus",
      "s3:GetBucketPublicAccessBlock",
      "s3:GetBucketAcl",
      "s3:GetBucketTagging",
    ],
    collect: collectS3,
  },
  iam: {
    scope: "global",
    relationships: ["HAS_POLICY", "MEMBER_OF", "PROVIDES_ROLE"],
    calls: { perUnit: 5, perResource: 0.01 },
    kinds: ["IamRole", "IamUser", "IamGroup", "IamPolicy", "InstanceProfile"],
    permissions: [
      "iam:GetAccountAuthorizationDetails",
      "iam:ListRoles",
      "iam:ListUsers",
      "iam:GetPolicy",
      "iam:GetPolicyVersion",
    ],
    collect: collectIam,
  },
  rds: {
    scope: "regional",
    relationships: ["HAS_SECURITY_GROUP", "IN_REGION", "IN_SUBNET", "USES_SUBNET_GROUP"],
    calls: { perUnit: 2, perResource: 0.01 },
    kinds: ["RdsInstance", "DbSubnetGroup"],
    permissions: ["rds:DescribeDBInstances", "rds:DescribeDBSubnetGroups"],
    collect: collectRds,
  },
  lambda: {
    scope: "regional",
    relationships: ["EXECUTES_AS", "HAS_SECURITY_GROUP", "IN_REGION", "IN_SUBNET"],
    calls: { perUnit: 1, perResource: 0.02 },
    kinds: ["LambdaFunction"],
    permissions: ["lambda:ListFunctions"],
    collect: collectLambda,
  },
  elbv2: {
    scope: "regional",
    relationships: ["FORWARDS_TO", "HAS_SECURITY_GROUP", "IN_REGION", "IN_SUBNET", "TARGETS"],
    calls: { perUnit: 2, perResource: 1 },
    kinds: ["LoadBalancer", "TargetGroup"],
    permissions: [
      "elasticloadbalancing:DescribeLoadBalancers",
      "elasticloadbalancing:DescribeListeners",
      "elasticloadbalancing:DescribeTargetGroups",
      "elasticloadbalancing:DescribeTargetHealth",
    ],
    collect: collectElbv2,
  },
  cloudfront: {
    scope: "global",
    relationships: [],
    calls: { perUnit: 1, perResource: 0.01 },
    kinds: ["CloudFrontDistribution"],
    permissions: ["cloudfront:ListDistributions"],
    collect: collectCloudFront,
  },
  apigateway: {
    scope: "regional",
    relationships: ["IN_REGION", "INTEGRATES_WITH"],
    calls: { perUnit: 2, perResource: 2 },
    kinds: ["ApiGateway"],
    // API Gateway's IAM actions are HTTP verbs on resource paths.
    permissions: ["apigateway:GET"],
    collect: collectApiGateway,
  },
  sqs: {
    scope: "regional",
    relationships: ["IN_REGION"],
    calls: { perUnit: 1, perResource: 1 },
    kinds: ["SqsQueue"],
    permissions: ["sqs:ListQueues", "sqs:GetQueueAttributes"],
    collect: collectSqs,
  },
  sns: {
    scope: "regional",
    relationships: ["IN_REGION"],
    calls: { perUnit: 1, perResource: 1 },
    kinds: ["SnsTopic"],
    permissions: ["sns:ListTopics", "sns:GetTopicAttributes"],
    collect: collectSns,
  },
  kms: {
    scope: "regional",
    relationships: ["IN_REGION"],
    calls: { perUnit: 1, perResource: 3 },
    kinds: ["KmsKey"],
    permissions: [
      "kms:ListKeys",
      "kms:DescribeKey",
      "kms:GetKeyPolicy",
      "kms:GetKeyRotationStatus",
    ],
    collect: collectKms,
  },
  secretsmanager: {
    scope: "regional",
    relationships: ["IN_REGION"],
    calls: { perUnit: 1, perResource: 1 },
    kinds: ["Secret"],
    permissions: ["secretsmanager:ListSecrets", "secretsmanager:GetResourcePolicy"],
    collect: collectSecrets,
  },
  dynamodb: {
    scope: "regional",
    relationships: ["IN_REGION"],
    calls: { perUnit: 1, perResource: 2 },
    kinds: ["DynamoTable"],
    permissions: [
      "dynamodb:ListTables",
      "dynamodb:DescribeTable",
      "dynamodb:DescribeContinuousBackups",
    ],
    collect: collectDynamoDb,
  },
  ecs: {
    scope: "regional",
    relationships: [
      "EXECUTES_AS",
      "HAS_SECURITY_GROUP",
      "IN_CLUSTER",
      "IN_REGION",
      "IN_SUBNET",
      "TARGETS",
    ],
    calls: { perUnit: 1, perResource: 2 },
    kinds: ["EcsCluster", "EcsService"],
    permissions: [
      "ecs:ListClusters",
      "ecs:ListServices",
      "ecs:DescribeServices",
      "ecs:DescribeTaskDefinition",
    ],
    collect: collectEcs,
  },
  eks: {
    scope: "regional",
    relationships: ["CAN_ASSUME", "EXECUTES_AS", "IN_CLUSTER", "IN_REGION", "IN_SUBNET"],
    calls: { perUnit: 1, perResource: 3 },
    kinds: ["EksCluster", "EksNodeGroup"],
    permissions: [
      "eks:ListClusters",
      "eks:DescribeCluster",
      "eks:ListNodegroups",
      "eks:DescribeNodegroup",
      "eks:ListPodIdentityAssociations",
      "eks:DescribePodIdentityAssociation",
    ],
    collect: collectEks,
  },
  route53: {
    scope: "global",
    relationships: [],
    calls: { perUnit: 1, perResource: 1 },
    kinds: ["HostedZone"],
    permissions: ["route53:ListHostedZones", "route53:ListResourceRecordSets"],
    collect: collectRoute53,
  },
  autoscaling: {
    scope: "regional",
    relationships: ["IN_REGION", "MANAGES"],
    calls: { perUnit: 1, perResource: 0.01 },
    kinds: ["AutoScalingGroup"],
    permissions: ["autoscaling:DescribeAutoScalingGroups"],
    collect: collectAutoScaling,
  },
};

/** For the consistency test: the scope each plugin declares, as the shared set expects. */
export const declaredGlobal = (): Set<ScannableService> =>
  new Set(
    (Object.entries(COLLECTORS) as [ScannableService, CollectorPlugin][])
      .filter(([, p]) => p.scope === "global")
      .map(([s]) => s),
  );
