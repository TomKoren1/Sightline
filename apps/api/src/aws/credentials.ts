/**
 * Cross-account credentials.
 *
 * dave.io never holds a customer's keys. It assumes a role *in the customer's
 * account*, presenting an external id that is unique to that customer. The
 * external id is what stops the confused-deputy attack: knowing the role ARN
 * is not enough, because the role's trust policy also requires a secret that
 * only dave.io and that customer share.
 *
 * The sessions AWS hands back are short-lived - the role template caps them at
 * one hour. A scan of a large estate can outlive that, so credentials are
 * cached and transparently renewed before they expire rather than after, which
 * would surface as an ExpiredToken failure halfway through a region.
 */

import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import type { AwsCredentialIdentity } from "@aws-sdk/types";
import { cfg, isMock } from "../config.js";

/**
 * Renew this long before expiry. A scan unit can run for a while, and a
 * credential that expires mid-request produces a confusing failure far from
 * its cause.
 */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export interface AssumedSession {
  credentials: AwsCredentialIdentity;
  accountId: string;
  assumedRoleArn: string;
  expiresAt: Date;
}

let cached: AssumedSession | null = null;
let inFlight: Promise<AssumedSession> | null = null;

function stsClient(): STSClient {
  return new STSClient({
    region: cfg.AWS_REGION,
    ...(isMock ? { endpoint: cfg.AWS_ENDPOINT_URL } : {}),
    // In `real` mode these are undefined, so the SDK falls back to the standard
    // credential chain: environment, shared config, container role, instance
    // role. That is how this runs in production - dave.io's own task role is
    // the only identity allowed to call AssumeRole on the customer role.
    ...(cfg.AWS_ACCESS_KEY_ID && cfg.AWS_SECRET_ACCESS_KEY
      ? {
          credentials: {
            accessKeyId: cfg.AWS_ACCESS_KEY_ID,
            secretAccessKey: cfg.AWS_SECRET_ACCESS_KEY,
          },
        }
      : {}),
  });
}

function isFresh(session: AssumedSession): boolean {
  return session.expiresAt.getTime() - Date.now() > REFRESH_MARGIN_MS;
}

async function assume(): Promise<AssumedSession> {
  const client = stsClient();
  const res = await client.send(
    new AssumeRoleCommand({
      RoleArn: cfg.AWS_TARGET_ROLE_ARN,
      // Surfaces in the customer's own CloudTrail, so they can see exactly
      // which dave.io process touched their account and when.
      RoleSessionName: "daveio-inventory-scanner",
      ExternalId: cfg.AWS_EXTERNAL_ID,
      DurationSeconds: 3600,
    }),
  );

  const creds = res.Credentials;
  if (!creds?.AccessKeyId || !creds.SecretAccessKey || !creds.SessionToken) {
    throw new Error("AssumeRole returned an incomplete credential set");
  }

  const assumedRoleArn = res.AssumedRoleUser?.Arn ?? cfg.AWS_TARGET_ROLE_ARN;
  const accountId = accountIdFromArn(assumedRoleArn) ?? accountIdFromArn(cfg.AWS_TARGET_ROLE_ARN);
  if (!accountId) {
    throw new Error(`Could not determine account id from role ARN ${cfg.AWS_TARGET_ROLE_ARN}`);
  }

  return {
    credentials: {
      accessKeyId: creds.AccessKeyId,
      secretAccessKey: creds.SecretAccessKey,
      sessionToken: creds.SessionToken,
      expiration: creds.Expiration,
    },
    accountId,
    assumedRoleArn,
    // moto does not always echo an expiry; assume the SDK maximum.
    expiresAt: creds.Expiration ?? new Date(Date.now() + 3600_000),
  };
}

/**
 * Current credentials for the customer account, assuming the role if needed.
 *
 * Concurrent callers during a refresh share one in-flight AssumeRole call
 * rather than stampeding STS - a scan fans out across many regions at once and
 * they all miss the cache at the same moment.
 */
export async function getSession(): Promise<AssumedSession> {
  if (cached && isFresh(cached)) return cached;
  if (inFlight) return inFlight;

  inFlight = assume()
    .then((session) => {
      cached = session;
      return session;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/** Drop the cached session. Used by tests and by an explicit reconnect. */
export function resetSession(): void {
  cached = null;
  inFlight = null;
}

export function accountIdFromArn(arn: string): string | null {
  const parts = arn.split(":");
  const account = parts[4];
  return account && /^\d{12}$/.test(account) ? account : null;
}

/**
 * A credential provider the AWS SDK can call per request. Returning the
 * `expiration` lets the SDK's own retry logic recognise expiry, while our
 * cache means it almost never has to.
 */
export async function credentialProvider(): Promise<AwsCredentialIdentity> {
  const session = await getSession();
  return session.credentials;
}
