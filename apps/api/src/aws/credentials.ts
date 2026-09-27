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
import {
  activeConnection,
  cfg,
  effectiveEndpoint,
  isHosted,
  isMock,
  sourceCredentials,
} from "../config.js";
import { getConnection, getExternalId } from "../tenancy/connections.js";
import { getTenant } from "../tenancy/tenants.js";
import type { TenantId } from "../tenancy/tenant.js";

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
   * Where this session's calls go: null for real AWS, the demo fixture's URL
   * for a tenant looking at the demo account.
   *
   * Carried on the session rather than read from configuration when a client
   * is built, so the endpoint is a property of *which account was assumed*.
   * Two tenants on one process can then be pointed at different places at the
   * same time, which a module-level value cannot express.
   */
  endpoint: string | null;
}

/**
 * Sessions, per tenant.
 *
 * This was a single module-level `cached`, which is correct for a deployment
 * with one AWS account and catastrophic for one with many: the first tenant to
 * scan would populate it, and every other tenant would then be handed
 * credentials for *that tenant's* AWS account. A map keyed by tenant is the
 * whole fix, and the in-flight map beside it keeps the stampede protection
 * per tenant rather than shared.
 */
const cached = new Map<string, AssumedSession>();
const inFlight = new Map<string, Promise<AssumedSession>>();

/** A tenant that has not connected an AWS account yet. */
export class NoConnectionError extends Error {
  readonly statusCode = 409;
  readonly code = "NO_CONNECTION";
  constructor() {
    super("No AWS account is connected yet.");
    this.name = "NoConnectionError";
  }
}

/**
 * Where a tenant's role and external id come from.
 *
 * Self-hosted reads configuration, which is what every version of this
 * project has done and what the demo depends on. Hosted reads the tenant's
 * own row and **never** falls back to configuration: a fallback here would
 * silently point one customer's scan at whatever account the operator had in
 * their environment (which, on the first hosted run, was mine).
 */
export interface ResolvedConnection {
  roleArn: string;
  externalId: string;
  endpoint: string | null;
  /**
   * Keys to sign the AssumeRole call with, when the target is the demo
   * fixture rather than real AWS.
   *
   * Carried on the connection rather than read from the environment inside
   * `assume()`, so the credentials used are a property of *which account is
   * being reached* rather than of the process. That is the same ambient-state
   * mistake as the shared session cache, one layer down.
   */
  sourceCredentials?: AwsCredentialIdentity;
}

/** A tenant who asked to look at the demo account. */
export class DemoUnavailableError extends Error {
  readonly statusCode = 409;
  readonly code = "DEMO_UNAVAILABLE";
  constructor() {
    super("The demo account is not configured on this deployment.");
    this.name = "DemoUnavailableError";
  }
}

/**
 * The demo account, as a connection.
 *
 * Fixed values from the operator's configuration - a tenant supplies nothing
 * here and cannot influence any of it, which is what keeps this different in
 * kind from the endpoint override hosted mode refuses (ADR-020).
 */
export function demoConnection(): ResolvedConnection {
  const endpoint = cfg.DEMO_AWS_ENDPOINT_URL;
  if (!endpoint) throw new DemoUnavailableError();
  return {
    roleArn: `arn:aws:iam::${cfg.DEMO_AWS_ACCOUNT_ID}:role/DaveIoReadOnlyRole`,
    externalId: "local-dev-external-id-0000",
    endpoint,
    // moto accepts any credentials; these exist so the SDK has something to
    // sign with and never falls through to a real credential chain.
    sourceCredentials: { accessKeyId: "demo", secretAccessKey: "demo" },
  };
}

export async function resolveConnection(tenantId: TenantId): Promise<ResolvedConnection> {
  if (!isHosted()) {
    const connection = activeConnection();
    const credentials = sourceCredentials();
    return {
      ...connection,
      endpoint: effectiveEndpoint(),
      ...(credentials ? { sourceCredentials: credentials } : {}),
    };
  }

  // Looking at the demo is a property of the tenant, so it is checked before
  // their own connection - somebody exploring the demo has usually not
  // connected an account yet, and must not be told to.
  const tenant = await getTenant(tenantId);
  if (tenant?.demoMode) return demoConnection();

  const connection = await getConnection(tenantId);
  if (!connection || connection.status === "disconnected") throw new NoConnectionError();

  const externalId = await getExternalId(tenantId);
  if (!externalId) throw new NoConnectionError();

  return { roleArn: connection.roleArn, externalId, endpoint: null };
}

function stsClient(connection: ResolvedConnection): STSClient {
  return new STSClient({
    region: cfg.AWS_REGION,
    // Passed explicitly rather than via AWS_ENDPOINT_URL, which is stripped from
    // the environment at startup so it cannot leak across a mode switch.
    ...(connection.endpoint ? { endpoint: connection.endpoint } : {}),
    // Omitted entirely in `real` mode unless genuine keys were configured, so
    // the SDK falls back to its standard chain: environment, shared config,
    // container role, instance role. In production that is dave.io's own task
    // role, the only identity the customer's trust policy names.
    //
    // `sourceCredentials()` is what decides, because a placeholder left in .env
    // would otherwise shadow real credentials - see the note in config.ts.
    ...(connection.sourceCredentials ? { credentials: connection.sourceCredentials } : {}),
  });
}

function isFresh(session: AssumedSession): boolean {
  return session.expiresAt.getTime() - Date.now() > REFRESH_MARGIN_MS;
}

async function assume(tenantId: TenantId): Promise<AssumedSession> {
  const connection = await resolveConnection(tenantId);
  const client = stsClient(connection);
  const res = await client.send(
    new AssumeRoleCommand({
      RoleArn: connection.roleArn,
      // Surfaces in the customer's own CloudTrail, so they can see exactly
      // which dave.io process touched their account and when.
      RoleSessionName: "daveio-inventory-scanner",
      ExternalId: connection.externalId,
      DurationSeconds: 3600,
    }),
  );

  const creds = res.Credentials;
  if (!creds?.AccessKeyId || !creds.SecretAccessKey || !creds.SessionToken) {
    throw new Error("AssumeRole returned an incomplete credential set");
  }

  const assumedRoleArn = res.AssumedRoleUser?.Arn ?? connection.roleArn;
  const accountId = accountIdFromArn(assumedRoleArn) ?? accountIdFromArn(connection.roleArn);
  if (!accountId) {
    throw new Error(`Could not determine account id from role ARN ${connection.roleArn}`);
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
    endpoint: connection.endpoint,
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
export async function getSession(tenantId: TenantId): Promise<AssumedSession> {
  const hit = cached.get(tenantId);
  if (hit && isFresh(hit)) return hit;

  const pending = inFlight.get(tenantId);
  if (pending) return pending;

  const promise = assume(tenantId)
    .then((session) => {
      cached.set(tenantId, session);
      return session;
    })
    .finally(() => {
      inFlight.delete(tenantId);
    });

  inFlight.set(tenantId, promise);
  return promise;
}

/**
 * Drop cached credentials.
 *
 * Called on reconnect, because the point of reconnecting is usually that the
 * previous credentials were wrong. With no tenant it clears everything, which
 * is what a self-hosted mode switch wants.
 */
export function resetSession(tenantId?: TenantId): void {
  if (tenantId) {
    cached.delete(tenantId);
    inFlight.delete(tenantId);
    return;
  }
  cached.clear();
  inFlight.clear();
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
export function credentialProviderFor(tenantId: TenantId): () => Promise<AwsCredentialIdentity> {
  return async () => (await getSession(tenantId)).credentials;
}

/**
 * The endpoint a tenant's clients should use, resolved before any are built.
 *
 * Returned rather than injected as an SDK provider: the SDK skips its own
 * regional resolution once `endpoint` is supplied, so "no override" has to
 * mean *not passing the option at all*, which cannot be expressed by a value
 * arriving later.
 */
export async function endpointFor(tenantId: TenantId): Promise<string | null> {
  return (await getSession(tenantId)).endpoint;
}
