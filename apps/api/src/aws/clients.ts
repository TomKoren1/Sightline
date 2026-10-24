/**
 * AWS client construction.
 *
 * Every client is built the same way, and the only difference between scanning
 * the demo fixture and scanning a real account is the endpoint override.
 * Assume-role, retries, throttling behaviour and pagination are identical in
 * both, which is the whole point of using a mock that speaks the real API.
 *
 * **A client cannot be constructed without naming whose account it will talk
 * to.** The target and the call counter arrive together as an `AwsContext`,
 * passed rather than read, because ambient state is a value that is correct
 * when there is one of something and silently wrong when there are many.
 */

import { EC2Client } from "@aws-sdk/client-ec2";
import { S3Client } from "@aws-sdk/client-s3";
import { IAMClient } from "@aws-sdk/client-iam";
import { RDSClient } from "@aws-sdk/client-rds";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { ResourceExplorer2Client } from "@aws-sdk/client-resource-explorer-2";
import { ElasticLoadBalancingV2Client } from "@aws-sdk/client-elastic-load-balancing-v2";
import { CloudFrontClient } from "@aws-sdk/client-cloudfront";
import { APIGatewayClient } from "@aws-sdk/client-api-gateway";
import { ApiGatewayV2Client } from "@aws-sdk/client-apigatewayv2";
import { SQSClient } from "@aws-sdk/client-sqs";
import { SNSClient } from "@aws-sdk/client-sns";
import { KMSClient } from "@aws-sdk/client-kms";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { ECSClient } from "@aws-sdk/client-ecs";
import { EKSClient } from "@aws-sdk/client-eks";
import { Route53Client } from "@aws-sdk/client-route-53";
import { AutoScalingClient } from "@aws-sdk/client-auto-scaling";
import { OrganizationsClient } from "@aws-sdk/client-organizations";

import { credentialProvider } from "./credentials.js";
import { accountOfRole, pace } from "./pace.js";
import { inSpan, tracingEnabled } from "../observability/tracing.js";
import type { ScanTarget } from "../tenancy/scanTarget.js";
import { awsApiCalls, awsThrottles } from "../observability/metrics.js";

/**
 * Counts AWS API calls, so a scan can report what it cost.
 *
 * One per scan rather than one per process: on a real account this is the
 * number that matters when a customer asks why their CloudTrail is busy, and a
 * shared counter would attribute one tenant's calls to another's scan.
 */
export class CallCounter {
  private counts = new Map<string, number>();

  record(key: string): void {
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  get(key: string): number {
    return this.counts.get(key) ?? 0;
  }

  total(): number {
    let sum = 0;
    for (const n of this.counts.values()) sum += n;
    return sum;
  }
}

/** Everything a client needs that is not the region. */
export interface AwsContext {
  target: ScanTarget;
  counter: CallCounter;
  /**
   * The scan unit making these calls, which they are counted under. Without
   * it, two units sharing a client - VPC and EC2 both use EC2's - were
   * counted under one key and each charged the other's calls.
   */
  unitKey?: string;
}

function baseConfig(ctx: AwsContext, region: string) {
  return {
    region,
    credentials: credentialProvider(ctx.target),
    /**
     * `adaptive` adds a client-side rate limiter that backs off when AWS
     * starts returning throttling errors, on top of the standard exponential
     * backoff with jitter. On a large account this is the difference between
     * a scan that degrades gracefully and one that hammers a throttled API.
     */
    retryMode: "adaptive" as const,
    maxAttempts: 5,
    // Explicit, and from the target rather than the environment: that variable
    // is stripped at startup so one connection's endpoint cannot leak into
    // another's requests.
    ...(ctx.target.endpoint ? { endpoint: ctx.target.endpoint } : {}),
  };
}

/**
 * The middleware stack, structurally.
 *
 * Each generated client types its stack against its own input and output
 * unions, so there is no shared supertype to write this against. The cast is
 * confined to this one bridge rather than leaking `any` into call sites.
 */
interface MiddlewareStack {
  add: (
    middleware: (
      next: (args: unknown) => Promise<unknown>,
      context: { commandName?: string; clientName?: string },
    ) => (args: unknown) => Promise<unknown>,
    options: { step: "deserialize"; name: string; override: boolean },
  ) => void;
}

/** AWS says "slow down" under several names, and none of them is an error we caused. */
const THROTTLE = /throttl|RequestLimitExceeded|TooManyRequests|SlowDown|ProvisionedThroughput/i;

/**
 * Attach a middleware that counts every request the client makes.
 *
 * Sits at the `deserialize` step so it counts attempts that reach the wire,
 * including retries - which is what we want, since retries are exactly what
 * costs us when throttled.
 */
function instrument<T extends object>(client: T, ctx: AwsContext, key: string): T {
  const { counter } = ctx;
  const { middlewareStack, config } = client as unknown as {
    middlewareStack: MiddlewareStack;
    config: { region: () => Promise<string> };
  };
  // Paced per account, SDK client and region: see pace.ts. Resolved once.
  let paceKey: Promise<string> | null = null;
  const keyFor = (clientName: string) =>
    (paceKey ??= config
      .region()
      .then((region) => `${accountOfRole(ctx.target.roleArn)}:${clientName}:${region}`));
  // `ec2:us-east-1` - the service half is the metric label, because a region
  // label here would duplicate what the scan unit already reports.
  const service = key.split(":")[0] ?? key;

  middlewareStack.add(
    (next, context) => async (args) => {
      await pace(await keyFor(context.clientName ?? service));
      counter.record(key);
      /**
       * The operation, from the SDK's own context: `DescribeInstancesCommand`.
       * A closed set per service, so it is a safe label - and it is the
       * difference between "the scan made 4,000 calls" and "it made 4,000
       * GetBucketPolicy calls, one per bucket".
       */
      const operation = (context.commandName ?? "unknown").replace(/Command$/, "");
      awsApiCalls.inc({ service, operation });

      try {
        if (!tracingEnabled()) return await next(args);
        return await inSpan(
          `aws ${service}.${operation}`,
          { "rpc.system": "aws-api", "rpc.service": service, "rpc.method": operation },
          () => next(args),
        );
      } catch (err) {
        // Counted separately because throttling is not our error: it is the
        // signal that a scan is competing with the customer's own workloads.
        const name = err instanceof Error ? err.name : String(err);
        if (THROTTLE.test(name)) awsThrottles.inc({ service });
        throw err;
      }
    },
    { step: "deserialize", name: "sightlineCallCounter", override: true },
  );
  return client;
}

export const ec2Client = (ctx: AwsContext, region: string) =>
  instrument(new EC2Client(baseConfig(ctx, region)), ctx, ctx.unitKey ?? `ec2:${region}`);

export const rdsClient = (ctx: AwsContext, region: string) =>
  instrument(new RDSClient(baseConfig(ctx, region)), ctx, ctx.unitKey ?? `rds:${region}`);

export const lambdaClient = (ctx: AwsContext, region: string) =>
  instrument(new LambdaClient(baseConfig(ctx, region)), ctx, ctx.unitKey ?? `lambda:${region}`);

export const elbv2Client = (ctx: AwsContext, region: string) =>
  instrument(
    new ElasticLoadBalancingV2Client(baseConfig(ctx, region)),
    ctx,
    ctx.unitKey ?? `elbv2:${region}`,
  );

/** CloudFront is global and answers in us-east-1, whatever region a scan runs in. */
export const cloudfrontClient = (ctx: AwsContext) =>
  instrument(
    new CloudFrontClient(baseConfig(ctx, "us-east-1")),
    ctx,
    ctx.unitKey ?? "cloudfront:global",
  );

export const apigatewayClient = (ctx: AwsContext, region: string) =>
  instrument(
    new APIGatewayClient(baseConfig(ctx, region)),
    ctx,
    ctx.unitKey ?? `apigateway:${region}`,
  );

export const apigatewayV2Client = (ctx: AwsContext, region: string) =>
  instrument(
    new ApiGatewayV2Client(baseConfig(ctx, region)),
    ctx,
    ctx.unitKey ?? `apigateway:${region}`,
  );

/** One regional client factory per service, counted under that service's unit. */
const regional =
  <T extends object>(Client: new (config: ReturnType<typeof baseConfig>) => T, service: string) =>
  (ctx: AwsContext, region: string) =>
    instrument(new Client(baseConfig(ctx, region)), ctx, ctx.unitKey ?? `${service}:${region}`);

export const sqsClient = regional(SQSClient, "sqs");
export const snsClient = regional(SNSClient, "sns");
export const kmsClient = regional(KMSClient, "kms");
export const secretsClient = regional(SecretsManagerClient, "secretsmanager");
export const dynamodbClient = regional(DynamoDBClient, "dynamodb");
export const ecsClient = regional(ECSClient, "ecs");
export const eksClient = regional(EKSClient, "eks");
export const autoScalingClient = regional(AutoScalingClient, "autoscaling");

/** Route 53 is global and answers in us-east-1. */
export const route53Client = (ctx: AwsContext) =>
  instrument(new Route53Client(baseConfig(ctx, "us-east-1")), ctx, ctx.unitKey ?? "route53:global");

export const resourceExplorerClient = (ctx: AwsContext, region: string) =>
  instrument(
    new ResourceExplorer2Client(baseConfig(ctx, region)),
    ctx,
    ctx.unitKey ?? `resource-explorer:${region}`,
  );

/** moto serves S3 from a single host, so path-style addressing is required. */
export const s3Client = (ctx: AwsContext, region: string) =>
  instrument(
    new S3Client({
      ...baseConfig(ctx, region),
      ...(ctx.target.kind === "demo" ? { forcePathStyle: true } : {}),
    }),
    ctx,
    // Counted under the global unit the runner reports, whichever region a
    // bucket lives in.
    "s3:global",
  );

/** IAM is global. Its endpoint lives in us-east-1 regardless of where we scan. */
/** Organizations is global; its endpoint is us-east-1 wherever the scan runs. */
export const organizationsClient = (ctx: AwsContext) =>
  instrument(
    new OrganizationsClient(baseConfig(ctx, "us-east-1")),
    ctx,
    ctx.unitKey ?? "organizations:global",
  );

export const iamClient = (ctx: AwsContext) =>
  instrument(new IAMClient(baseConfig(ctx, "us-east-1")), ctx, ctx.unitKey ?? "iam:global");
