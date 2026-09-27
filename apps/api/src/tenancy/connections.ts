/**
 * A tenant's AWS connection.
 *
 * One row per tenant: the role we assume, the account it turned out to belong
 * to, and the external id that authorises the assumption — encrypted, because
 * it is half of a credential for somebody else's cloud.
 *
 * The **account id is pinned when the connection is verified**, not taken from
 * the role ARN at scan time. A role ARN that is edited later cannot then
 * quietly repoint an existing connection, its history and its graph at a
 * different account: the mismatch is detected and the scan refuses rather than
 * silently recording one account's inventory under another's name. That is
 * engineering log #31 arriving through a multi-tenant door, and it is the same
 * fix — trust what the assumed session reports, compare it with what was
 * agreed.
 */

import type { PoolClient } from "pg";

import { pool } from "../db/postgres.js";
import { decryptSecret, encryptSecret, generateExternalId } from "./secrets.js";
import type { TenantId } from "./tenant.js";

export type ConnectionStatus = "pending" | "verified" | "failed" | "disconnected";

export interface Connection {
  tenantId: TenantId;
  roleArn: string;
  /** Null until the first successful assume-role tells us what it really is. */
  accountId: string | null;
  status: ConnectionStatus;
  lastVerifiedAt: string | null;
  lastError: string | null;
}

/** The connection, with the external id still encrypted. */
export async function getConnection(tenantId: TenantId): Promise<Connection | null> {
  const { rows } = await pool.query(
    `SELECT tenant_id, role_arn, account_id, status, last_verified_at, last_error
       FROM connections WHERE tenant_id = $1`,
    [tenantId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    tenantId: row.tenant_id,
    roleArn: row.role_arn,
    accountId: row.account_id,
    status: row.status,
    lastVerifiedAt: row.last_verified_at ? row.last_verified_at.toISOString() : null,
    lastError: row.last_error,
  };
}

/**
 * The external id, decrypted.
 *
 * Separate from `getConnection` on purpose: the common path - rendering
 * connection state in the UI - never needs the secret, and a function that
 * returns it by default is one that will eventually return it into a response
 * body. Callers have to ask.
 *
 * Stored on the **tenant**, not the connection: it identifies this customer to
 * AWS and does not depend on which role they point at, and it has to exist
 * before a role does - the customer needs it to deploy the stack that creates
 * the role in the first place.
 */
export async function getExternalId(tenantId: TenantId): Promise<string | null> {
  const { rows } = await pool.query(`SELECT external_id_encrypted FROM tenants WHERE id = $1`, [
    tenantId,
  ]);
  const blob = rows[0]?.external_id_encrypted;
  return blob ? decryptSecret(blob) : null;
}

/**
 * The tenant's external id, issuing one the first time it is asked for.
 *
 * Issuing on read rather than on save is the whole point: the customer is
 * shown this value so they can put it in their CloudFormation stack, and that
 * has to be the same string the service will later present when assuming the
 * role. Generating a fresh one at save time produced a stack and a service
 * that disagreed, which surfaces as AccessDenied with nothing to suggest why.
 *
 * The write is conditional, so two browser tabs asking at once still end up
 * with one id rather than the second overwriting the first.
 */
export async function getOrIssueExternalId(tenantId: TenantId): Promise<string> {
  const existing = await getExternalId(tenantId);
  if (existing) return existing;

  const issued = generateExternalId();
  await pool.query(
    `UPDATE tenants SET external_id_encrypted = $2
      WHERE id = $1 AND external_id_encrypted IS NULL`,
    [tenantId, await encryptSecret(issued)],
  );
  // Re-read rather than returning what we generated: if another request won
  // the race, theirs is the one now stored.
  return (await getExternalId(tenantId)) ?? issued;
}

/**
 * Issue a new external id, invalidating the old one.
 *
 * Deliberately explicit and never a side effect of editing a role ARN: a
 * customer who has already deployed their stack would start getting
 * AccessDenied with no reason to suspect us.
 */
export async function rotateExternalId(tenantId: TenantId): Promise<string> {
  const issued = generateExternalId();
  await pool.query(`UPDATE tenants SET external_id_encrypted = $2 WHERE id = $1`, [
    tenantId,
    await encryptSecret(issued),
  ]);
  await pool.query(
    `UPDATE connections SET status = 'pending', last_error = NULL, updated_at = now()
      WHERE tenant_id = $1`,
    [tenantId],
  );
  return issued;
}

/** Create or replace a tenant's connection. The external id is rotated with it. */
export async function upsertConnection(
  tenantId: TenantId,
  params: { roleArn: string },
): Promise<void> {
  await pool.query(
    `INSERT INTO connections (tenant_id, role_arn, status, updated_at)
     VALUES ($1, $2, 'pending', now())
     ON CONFLICT (tenant_id) DO UPDATE SET
       role_arn = EXCLUDED.role_arn,
       -- A changed role invalidates the previous verification: the connection
       -- is unproven again until it is tested. The external id is untouched,
       -- because the customer's stack already contains it.
       status = 'pending',
       account_id = NULL,
       last_error = NULL,
       updated_at = now()`,
    [tenantId, params.roleArn],
  );
}

/** Record a successful assume-role, pinning the account it reached. */
export async function markVerified(tenantId: TenantId, accountId: string): Promise<void> {
  await pool.query(
    `UPDATE connections
        SET status = 'verified', account_id = $2, last_verified_at = now(),
            last_error = NULL, updated_at = now()
      WHERE tenant_id = $1`,
    [tenantId, accountId],
  );
}

export async function markFailed(tenantId: TenantId, error: string): Promise<void> {
  await pool.query(
    `UPDATE connections
        SET status = 'failed', last_error = $2, updated_at = now()
      WHERE tenant_id = $1`,
    [tenantId, error],
  );
}

/**
 * Does the account we actually reached match the one agreed?
 *
 * Returns the problem, or null. A pure function so the rule is testable
 * without a database or an AWS call - the comparison is the whole point, and
 * it is one line that is easy to get backwards.
 */
export function accountMismatch(pinned: string | null, reached: string): string | null {
  if (!pinned) return null; // First verification: nothing to contradict yet.
  if (pinned === reached) return null;
  return (
    `This connection was verified against account ${pinned}, but the role now ` +
    `assumes into account ${reached}. Refusing to scan: inventory recorded under ` +
    "the wrong account is worse than no inventory. Reconnect if the change was intended."
  );
}

/**
 * Forget everything about a tenant's connection.
 *
 * Deliberately does **not** claim the customer is disconnected: only they can
 * delete the CloudFormation stack that trusts us. The caller is expected to
 * tell them so - see docs/HOSTED-PLAN.md §10.
 */
export async function deleteConnection(
  tenantId: TenantId,
  client: PoolClient | typeof pool = pool,
): Promise<void> {
  await client.query(`DELETE FROM connections WHERE tenant_id = $1`, [tenantId]);
}
