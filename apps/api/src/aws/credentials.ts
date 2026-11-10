/**
 * Cross-account credentials.
 *
 * Sightline never holds a customer's keys. It assumes a role *in the
 * customer's account*, presenting an external id unique to that connection.
 * The external id is what stops the confused-deputy attack: knowing the role
 * ARN is not enough, because the trust policy also requires a secret that only
 * Sightline and that customer share.
 *
 * The sessions AWS hands back are short-lived - the role template caps them at
 * one hour. A scan of a large estate can outlive that, so credentials are
 * cached and renewed *before* they expire rather than after, which would
 * surface as an ExpiredToken failure halfway through a region.
 *
 * **The cache is keyed by connection.** It used to be a single module-level
 * variable, which is correct for one operator and would otherwise have handed
 * the first tenant's credentials to everyone who arrived after them. The
 * stampede protection that used to be global is kept, per key.
 */

import { STSClient, AssumeRoleCommand, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import type { AwsCredentialIdentity } from "@aws-sdk/types";

import { cfg } from "../core/config.js";
import { sourceCredentials, sourceIdentity } from "./settings.js";
import { assumablePrincipalArn, type PrincipalResolution } from "./principal.js";
import type { ScanTarget } from "../core/scanTarget.js";

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
  /**
   * The endpoint this session's clients must use, carried with the credentials
   * rather than read from configuration. That is what lets one process serve a
   * tenant on the demo fixture and a tenant on real AWS simultaneously.
   */
  endpoint: string | null;
}

const cache = new Map<string, AssumedSession>();
const inFlight = new Map<string, Promise<AssumedSession>>();

function stsClient(target: ScanTarget): STSClient {
  return new STSClient({
    region: cfg.AWS_REGION,
    // Passed explicitly rather than via AWS_ENDPOINT_URL, which is stripped
    // from the environment at startup so it cannot leak across connections.
    ...(target.endpoint ? { endpoint: target.endpoint } : {}),
    // Omitted entirely for a real account unless genuine keys were configured,
    // so the SDK falls back to its standard chain: environment, shared config,
    // container role, instance role. In production that is Sightline's own
    // scanner identity, the only principal a customer's trust policy names.
    ...(() => {
      const credentials = sourceCredentials(target.kind === "demo");
      return credentials ? { credentials } : {};
    })(),
  });
}

function isFresh(session: AssumedSession): boolean {
  return session.expiresAt.getTime() - Date.now() > REFRESH_MARGIN_MS;
}

async function assume(target: ScanTarget): Promise<AssumedSession> {
  const res = await stsClient(target).send(
    new AssumeRoleCommand({
      RoleArn: target.roleArn,
      // Surfaces in the customer's own CloudTrail, so they can see exactly
      // which Sightline process touched their account and when.
      RoleSessionName: "sightline-inventory-scanner",
      /**
       * Who triggered this scan, as opposed to which role ran it.
       *
       * `RoleSessionName` is chosen per-assume by the caller and is replaced at
       * every hop of a role chain, so it attributes nothing the customer can
       * rely on. `SourceIdentity` cannot be changed for the life of the session
       * and persists across chained roles, and the trust policy both requires
       * it and constrains its prefix - so this is the value the customer's own
       * CloudTrail records, whether or not Sightline wants it there.
       *
       * The trust policy's `Null` condition makes this mandatory, so omitting
       * it fails every scan loudly rather than silently losing attribution.
       */
      SourceIdentity: sourceIdentity(),
      ExternalId: target.externalId,
      DurationSeconds: 3600,
    }),
  );

  const creds = res.Credentials;
  if (!creds?.AccessKeyId || !creds.SecretAccessKey || !creds.SessionToken) {
    throw new Error("AssumeRole returned an incomplete credential set");
  }

  const assumedRoleArn = res.AssumedRoleUser?.Arn ?? target.roleArn;
  const accountId = accountIdFromArn(assumedRoleArn) ?? accountIdFromArn(target.roleArn);
  if (!accountId) {
    throw new Error(`Could not determine account id from role ARN ${target.roleArn}`);
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
    endpoint: target.endpoint,
    // moto does not always echo an expiry; assume the SDK maximum.
    expiresAt: creds.Expiration ?? new Date(Date.now() + 3600_000),
  };
}

/**
 * Who this process authenticates as, in a form a trust policy can name.
 *
 * The principal a customer's role must trust. Hosted deployments configure it
 * as `SCANNER_PRINCIPAL_ARN`, because the api and the worker there hold
 * *different* identities on purpose - `deploy/k8s/base/app.yaml` gives the
 * scanner secret to the worker alone. A self-hosted clone has one topology,
 * docker-compose, where both read the same `.env` and the same mounted
 * `~/.aws`, so either process answers the same thing and this is safe to ask
 * here. That precondition is why callers must restrict it to self-hosted.
 *
 * `endpoint` exists only so a test can answer this. `config.ts` deliberately
 * deletes `AWS_ENDPOINT_URL_STS` from the environment - an SDK-wide override
 * would redirect `sts:AssumeRole` too - so there is no other way to point the
 * client at a stand-in. Production passes nothing.
 */
let identityCache: string | null = null;

export async function scannerIdentityArn(endpoint?: string): Promise<PrincipalResolution> {
  if (identityCache) return assumablePrincipalArn(identityCache);
  let arn: string | undefined;
  try {
    const sts = new STSClient({
      region: cfg.AWS_REGION,
      credentials: sourceCredentials(false),
      ...(endpoint ? { endpoint } : {}),
    });
    arn = (await sts.send(new GetCallerIdentityCommand({}))).Arn;
  } catch (err) {
    // Only a success is cached: an operator who runs `aws sso login` after
    // seeing this should get a different answer without restarting.
    return {
      ok: false,
      reason:
        "no AWS credentials were found, so there is no principal for the trust policy to name. " +
        `Mount a profile or set SCANNER_PRINCIPAL_ARN. (${(err as Error).message})`,
    };
  }
  if (!arn) return { ok: false, reason: "sts:GetCallerIdentity returned no ARN" };
  identityCache = arn;
  return assumablePrincipalArn(arn);
}

/** Forget the cached identity, for tests and for `resetSession`'s callers. */
export function resetScannerIdentity(): void {
  identityCache = null;
}

/**
 * Current credentials for one connection's account, assuming the role if
 * needed.
 *
 * Concurrent callers during a refresh share one in-flight AssumeRole call
 * rather than stampeding STS - a scan fans out across many regions at once and
 * they all miss the cache at the same moment.
 */
export async function getSession(target: ScanTarget): Promise<AssumedSession> {
  const key = target.connectionId;

  const cached = cache.get(key);
  if (cached && isFresh(cached)) return cached;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const promise = assume(target)
    .then((session) => {
      cache.set(key, session);
      return session;
    })
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, promise);
  return promise;
}

/**
 * Drop cached sessions. Used by tests and by an explicit reconnect.
 *
 * Per connection, because an operator reconnecting one account has no business
 * invalidating every other tenant's working session.
 */
export function resetSession(connectionId?: string): void {
  if (connectionId === undefined) {
    cache.clear();
    inFlight.clear();
    return;
  }
  cache.delete(connectionId);
  inFlight.delete(connectionId);
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
export function credentialProvider(target: ScanTarget): () => Promise<AwsCredentialIdentity> {
  return async () => (await getSession(target)).credentials;
}
