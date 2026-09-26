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
import { decryptSecret, encryptSecret } from "./secrets.js";
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
 */
export async function getExternalId(tenantId: TenantId): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT external_id_encrypted FROM connections WHERE tenant_id = $1`,
    [tenantId],
  );
  const blob = rows[0]?.external_id_encrypted;
  return blob ? decryptSecret(blob) : null;
}

/** Create or replace a tenant's connection. The external id is rotated with it. */
export async function upsertConnection(
  tenantId: TenantId,
  params: { roleArn: string; externalId: string },
): Promise<void> {
  const encrypted = await encryptSecret(params.externalId);
  await pool.query(
    `INSERT INTO connections (tenant_id, role_arn, external_id_encrypted, status, updated_at)
     VALUES ($1, $2, $3, 'pending', now())
     ON CONFLICT (tenant_id) DO UPDATE SET
       role_arn = EXCLUDED.role_arn,
       external_id_encrypted = EXCLUDED.external_id_encrypted,
       -- A changed role or external id invalidates the previous verification:
       -- the connection is unproven again until it is tested.
       status = 'pending',
       account_id = NULL,
       last_error = NULL,
       updated_at = now()`,
    [tenantId, params.roleArn, encrypted],
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
