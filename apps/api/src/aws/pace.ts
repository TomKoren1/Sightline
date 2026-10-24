/**
 * A token bucket per account, service and region, every AWS request waits on.
 *
 * AWS throttles each API per account and per region, and a scan has nothing
 * else telling it to slow down until it is already being refused: the
 * adaptive retry mode backs off after a throttle, this keeps the scan under
 * the line in the first place. Keyed on all three, so EC2 in one region never
 * waits behind IAM or behind another region, while two scans of the same
 * account in one worker - an organization's members, say - share the
 * account's allowance as AWS does. Process-wide, and in memory: two worker
 * replicas each pace their own scans.
 */

import { cfg } from "../config.js";

interface Bucket {
  tokens: number;
  updatedAt: number;
  /** Requests waiting, in arrival order. */
  waiting: (() => void)[];
  timer: ReturnType<typeof setTimeout> | null;
}

const buckets = new Map<string, Bucket>();

function refill(bucket: Bucket, rate: number, now: number): void {
  bucket.tokens = Math.min(rate, bucket.tokens + ((now - bucket.updatedAt) / 1000) * rate);
  bucket.updatedAt = now;
}

function drain(key: string, rate: number): void {
  const bucket = buckets.get(key)!;
  bucket.timer = null;
  refill(bucket, rate, Date.now());
  while (bucket.waiting.length > 0 && bucket.tokens >= 1) {
    bucket.tokens -= 1;
    bucket.waiting.shift()!();
  }
  if (bucket.waiting.length > 0) {
    bucket.timer = setTimeout(
      () => drain(key, rate),
      Math.ceil(((1 - bucket.tokens) / rate) * 1000),
    );
  } else if (bucket.tokens >= rate) {
    // Full and idle: nothing to remember, and a scan of every region of
    // every service would otherwise leave thousands of these behind.
    buckets.delete(key);
  }
}

/** Resolves when a request to this account, service and region may go. */
export function pace(key: string, rate = cfg.SCAN_AWS_REQUESTS_PER_SECOND): Promise<void> {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket) {
    // A bucket left part-empty and idle would otherwise stay for ever; one
    // untouched for a minute has refilled, so forgetting it changes nothing.
    if (buckets.size >= 10_000) {
      for (const [k, b] of buckets) {
        if (b.waiting.length === 0 && now - b.updatedAt > 60_000) buckets.delete(k);
      }
    }
    bucket = { tokens: rate, updatedAt: now, waiting: [], timer: null };
    buckets.set(key, bucket);
  }
  refill(bucket, rate, now);
  if (bucket.waiting.length === 0 && bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    bucket.waiting.push(resolve);
    bucket.timer ??= setTimeout(
      () => drain(key, rate),
      Math.ceil(((1 - bucket.tokens) / rate) * 1000),
    );
  });
}

/** The account a role ARN belongs to, for the key. */
export const accountOfRole = (roleArn: string): string =>
  /^arn:aws[\w-]*:iam::(\d{12}):/.exec(roleArn)?.[1] ?? roleArn;
