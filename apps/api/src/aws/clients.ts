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

import { credentialProvider } from "./credentials.js";
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
      context: { commandName?: string },
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
function instrument<T extends object>(client: T, counter: CallCounter, key: string): T {
  const { middlewareStack } = client as unknown as { middlewareStack: MiddlewareStack };
  // `ec2:us-east-1` - the service half is the metric label, because a region
  // label here would duplicate what the scan unit already reports.
  const service = key.split(":")[0] ?? key;

  middlewareStack.add(
    (next, context) => async (args) => {
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
        return await next(args);
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
  instrument(new EC2Client(baseConfig(ctx, region)), ctx.counter, `ec2:${region}`);

export const rdsClient = (ctx: AwsContext, region: string) =>
  instrument(new RDSClient(baseConfig(ctx, region)), ctx.counter, `rds:${region}`);

export const lambdaClient = (ctx: AwsContext, region: string) =>
  instrument(new LambdaClient(baseConfig(ctx, region)), ctx.counter, `lambda:${region}`);

export const resourceExplorerClient = (ctx: AwsContext, region: string) =>
  instrument(
    new ResourceExplorer2Client(baseConfig(ctx, region)),
    ctx.counter,
    `resource-explorer:${region}`,
  );

/** moto serves S3 from a single host, so path-style addressing is required. */
export const s3Client = (ctx: AwsContext, region: string) =>
  instrument(
    new S3Client({
      ...baseConfig(ctx, region),
      ...(ctx.target.kind === "demo" ? { forcePathStyle: true } : {}),
    }),
    ctx.counter,
    `s3:${region}`,
  );

/** IAM is global. Its endpoint lives in us-east-1 regardless of where we scan. */
export const iamClient = (ctx: AwsContext) =>
  instrument(new IAMClient(baseConfig(ctx, "us-east-1")), ctx.counter, "iam:global");
