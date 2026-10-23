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
    ],
    permissions: [
      "ec2:DescribeVpcs",
      "ec2:DescribeSubnets",
      "ec2:DescribeSecurityGroups",
      "ec2:DescribeInternetGateways",
      "ec2:DescribeNatGateways",
      "ec2:DescribeRouteTables",
      "ec2:DescribeNetworkAcls",
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
};

/** For the consistency test: the scope each plugin declares, as the shared set expects. */
export const declaredGlobal = (): Set<ScannableService> =>
  new Set(
    (Object.entries(COLLECTORS) as [ScannableService, CollectorPlugin][])
      .filter(([, p]) => p.scope === "global")
      .map(([s]) => s),
  );
