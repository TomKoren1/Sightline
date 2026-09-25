/**
 * AWS clients used to *build* the mock account.
 *
 * The seeder deliberately uses plain static credentials rather than the
 * assume-role path the scanner uses. Conceptually the seeder is the customer's
 * own administrator setting their account up; dave.io only ever arrives later,
 * through the read-only role. Keeping them separate also keeps us out of a
 * moto trap: moto namespaces resources by the account id carried in the
 * credentials, so seeding and scanning must agree on the account.
 */

import { EC2Client } from "@aws-sdk/client-ec2";
import { S3Client } from "@aws-sdk/client-s3";
import { IAMClient } from "@aws-sdk/client-iam";
import { RDSClient } from "@aws-sdk/client-rds";
import { LambdaClient } from "@aws-sdk/client-lambda";

const endpoint = process.env.AWS_ENDPOINT_URL ?? "http://localhost:5000";

const credentials = {
  accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "mock",
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "mock",
};

const base = (region: string) => ({ endpoint, region, credentials });

export const ec2 = (region: string) => new EC2Client(base(region));
export const s3 = (region: string) => new S3Client({ ...base(region), forcePathStyle: true });
export const rds = (region: string) => new RDSClient(base(region));
export const lambda = (region: string) => new LambdaClient(base(region));
/** IAM is global; region is a formality. */
export const iam = () => new IAMClient(base("us-east-1"));

export const MOTO_ENDPOINT = endpoint;

/** Wipe all moto state, so seeding is reproducible and evals are deterministic. */
export async function resetMoto(): Promise<void> {
  const res = await fetch(`${endpoint}/moto-api/reset`, { method: "POST" });
  if (!res.ok) throw new Error(`moto reset failed: ${res.status} ${await res.text()}`);
}

export async function waitForMoto(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${endpoint}/moto-api/`);
      if (res.ok) return;
      lastError = `status ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`moto not reachable at ${endpoint} after ${timeoutMs}ms: ${lastError}`);
}
