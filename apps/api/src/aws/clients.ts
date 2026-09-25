/**
 * AWS client construction.
 *
 * Every client is built the same way, and the only difference between scanning
 * a mock and scanning a real account is the endpoint override. Assume-role,
 * retries, throttling behaviour and pagination are identical in both, which is
 * the whole point of using a mock that speaks the real API.
 */

import { EC2Client } from "@aws-sdk/client-ec2";
import { S3Client } from "@aws-sdk/client-s3";
import { IAMClient } from "@aws-sdk/client-iam";
import { RDSClient } from "@aws-sdk/client-rds";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { ResourceExplorer2Client } from "@aws-sdk/client-resource-explorer-2";

import { cfg, isMock } from "../config.js";
import { credentialProvider } from "./credentials.js";

/**
 * Counts AWS API calls per scan, so a scan can report what it cost.
 *
 * On a real account this is the number that matters when a customer asks why
 * their CloudTrail is busy, and it is the first thing to look at when a scan
 * starts getting throttled.
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

export const callCounter = new CallCounter();

function baseConfig(region: string) {
  return {
    region,
    credentials: credentialProvider,
    /**
     * `adaptive` adds a client-side rate limiter that backs off when AWS
     * starts returning throttling errors, on top of the standard exponential
     * backoff with jitter. On a large account this is the difference between
     * a scan that degrades gracefully and one that hammers a throttled API.
     */
    retryMode: "adaptive" as const,
    maxAttempts: 5,
    ...(isMock ? { endpoint: cfg.AWS_ENDPOINT_URL } : {}),
  };
}

/**
 * Attach a middleware that counts every request the client makes.
 *
 * Sits at the `deserialize` step so it counts attempts that reach the wire,
 * including retries - which is what we want, since retries are exactly what
 * costs us when throttled.
 */
/**
 * The middleware stack, structurally.
 *
 * Each generated client types its stack against its own input and output
 * unions, so there is no shared supertype to write this against. The cast is
 * confined to this one bridge rather than leaking `any` into call sites.
 */
type MiddlewareStack = {
  add: (
    middleware: (next: (args: unknown) => Promise<unknown>) => (args: unknown) => Promise<unknown>,
    options: { step: "deserialize"; name: string; override: boolean },
  ) => void;
};

function instrument<T extends object>(client: T, key: string): T {
  const { middlewareStack } = client as unknown as { middlewareStack: MiddlewareStack };
  middlewareStack.add(
    (next) => async (args) => {
      callCounter.record(key);
      return next(args);
    },
    { step: "deserialize", name: "daveioCallCounter", override: true },
  );
  return client;
}

export const ec2Client = (region: string) =>
  instrument(new EC2Client(baseConfig(region)), `ec2:${region}`);

export const rdsClient = (region: string) =>
  instrument(new RDSClient(baseConfig(region)), `rds:${region}`);

export const lambdaClient = (region: string) =>
  instrument(new LambdaClient(baseConfig(region)), `lambda:${region}`);

export const resourceExplorerClient = (region: string) =>
  instrument(new ResourceExplorer2Client(baseConfig(region)), `resource-explorer:${region}`);

/** moto serves S3 from a single host, so path-style addressing is required. */
export const s3Client = (region: string) =>
  instrument(
    new S3Client({ ...baseConfig(region), ...(isMock ? { forcePathStyle: true } : {}) }),
    `s3:${region}`,
  );

/** IAM is global. Its endpoint lives in us-east-1 regardless of where we scan. */
export const iamClient = () => instrument(new IAMClient(baseConfig("us-east-1")), "iam:global");
