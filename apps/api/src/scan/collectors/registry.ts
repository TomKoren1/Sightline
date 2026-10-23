/**
 * Every collector, and what it needs.
 *
 * Adding a service is one entry here plus its collector: the `Record` refuses
 * to compile until every id in `SCANNABLE_SERVICES` has one, and the runner
 * plans its units, scopes them and explains a permission failure from these
 * fields alone.
 */

import type { ResourceKind, ScannableService } from "@sightline/shared";

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
  /** The read-only actions it calls, named in the error when one is refused. */
  permissions: readonly string[];
  collect: Collector;
}

export const COLLECTORS: Record<ScannableService, CollectorPlugin> = {
  ec2: {
    scope: "regional",
    kinds: ["Ec2Instance", "EbsVolume", "ElasticIp"],
    permissions: ["ec2:DescribeInstances", "ec2:DescribeVolumes", "ec2:DescribeAddresses"],
    collect: collectEc2,
  },
  vpc: {
    scope: "regional",
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
    kinds: ["RdsInstance", "DbSubnetGroup"],
    permissions: ["rds:DescribeDBInstances", "rds:DescribeDBSubnetGroups"],
    collect: collectRds,
  },
  lambda: {
    scope: "regional",
    kinds: ["LambdaFunction"],
    permissions: ["lambda:ListFunctions"],
    collect: collectLambda,
  },
  elbv2: {
    scope: "regional",
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
    kinds: ["CloudFrontDistribution"],
    permissions: ["cloudfront:ListDistributions"],
    collect: collectCloudFront,
  },
  apigateway: {
    scope: "regional",
    kinds: ["ApiGateway"],
    // API Gateway's IAM actions are HTTP verbs on resource paths.
    permissions: ["apigateway:GET"],
    collect: collectApiGateway,
  },
  sqs: {
    scope: "regional",
    kinds: ["SqsQueue"],
    permissions: ["sqs:ListQueues", "sqs:GetQueueAttributes"],
    collect: collectSqs,
  },
  sns: {
    scope: "regional",
    kinds: ["SnsTopic"],
    permissions: ["sns:ListTopics", "sns:GetTopicAttributes"],
    collect: collectSns,
  },
  kms: {
    scope: "regional",
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
    kinds: ["Secret"],
    permissions: ["secretsmanager:ListSecrets", "secretsmanager:GetResourcePolicy"],
    collect: collectSecrets,
  },
  dynamodb: {
    scope: "regional",
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
    kinds: ["EksCluster"],
    permissions: ["eks:ListClusters", "eks:DescribeCluster"],
    collect: collectEks,
  },
  route53: {
    scope: "global",
    kinds: ["HostedZone"],
    permissions: ["route53:ListHostedZones", "route53:ListResourceRecordSets"],
    collect: collectRoute53,
  },
  autoscaling: {
    scope: "regional",
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
