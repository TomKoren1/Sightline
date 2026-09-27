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

import { isMock } from "../config.js";
import { credentialProviderFor } from "./credentials.js";
import type { TenantId } from "../tenancy/tenant.js";

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

/**
 * Client configuration for one tenant.
 *
 * The tenant is a parameter rather than ambient state, so a client cannot be
 * built without saying whose account it will talk to. That used to be a
 * module-level credential provider, which in a multi-tenant process means
 * every client shares whichever tenant assumed a role first (ADR-019).
 */
function baseConfig(region: string, tenantId: TenantId, endpoint: string | null) {
  return {
    region,
    credentials: credentialProviderFor(tenantId),
    /**
     * Passed in rather than read from configuration.
     *
     * "No override" has to mean *not setting the option*, because the SDK
     * stops resolving regional endpoints itself once it is set - so this
     * cannot be a value that arrives later. It comes from the tenant's own
     * assumed session, which is what lets one process serve a tenant on the
     * demo fixture and a tenant on real AWS at the same moment (ADR-020).
     */
    ...(endpoint ? { endpoint } : {}),
    /**
     * `adaptive` adds a client-side rate limiter that backs off when AWS
     * starts returning throttling errors, on top of the standard exponential
     * backoff with jitter. On a large account this is the difference between
     * a scan that degrades gracefully and one that hammers a throttled API.
     */
    retryMode: "adaptive" as const,
    maxAttempts: 5,
    // Never via AWS_ENDPOINT_URL: that variable is stripped from the
    // environment at startup so it cannot leak across a switch, and hosted
    // mode refuses to start when it is set at all (ADR-015).
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

export const ec2Client = (region: string, tenantId: TenantId, endpoint: string | null = null) =>
  instrument(new EC2Client(baseConfig(region, tenantId, endpoint)), `ec2:${region}`);

export const rdsClient = (region: string, tenantId: TenantId, endpoint: string | null = null) =>
  instrument(new RDSClient(baseConfig(region, tenantId, endpoint)), `rds:${region}`);

export const lambdaClient = (region: string, tenantId: TenantId, endpoint: string | null = null) =>
  instrument(new LambdaClient(baseConfig(region, tenantId, endpoint)), `lambda:${region}`);

export const resourceExplorerClient = (
  region: string,
  tenantId: TenantId,
  endpoint: string | null = null,
) =>
  instrument(
    new ResourceExplorer2Client(baseConfig(region, tenantId, endpoint)),
    `resource-explorer:${region}`,
  );

/** moto serves S3 from a single host, so path-style addressing is required. */
export const s3Client = (region: string, tenantId: TenantId, endpoint: string | null = null) =>
  instrument(
    new S3Client({
      ...baseConfig(region, tenantId, endpoint),
      ...(isMock() ? { forcePathStyle: true } : {}),
    }),
    `s3:${region}`,
  );

/** IAM is global. Its endpoint lives in us-east-1 regardless of where we scan. */
export const iamClient = (tenantId: TenantId, endpoint: string | null = null) =>
  instrument(new IAMClient(baseConfig("us-east-1", tenantId, endpoint)), "iam:global");
