/**
 * Users, and the tenant each one belongs to.
 *
 * Signing in for the first time creates **both**: a tenant, and a user in it.
 * That is the whole onboarding path - there is no "create an organisation"
 * step, because a tenant with one member is what every account starts as, and
 * inventing the ceremony before anyone has asked for teams would be building
 * for an imagined user.
 *
 * `users.tenant_id` exists from the start even so, because adding a second
 * member later is then a row, and retrofitting tenancy onto a `user_id`-keyed
 * schema is a migration nobody enjoys.
 */

import { randomUUID } from "node:crypto";

import { pool } from "../db/postgres.js";
import { asTenantId, type TenantId } from "../tenancy/tenant.js";

export interface User {
  id: string;
  tenantId: TenantId;
  provider: "google" | "github" | "local";
  email: string | null;
}

/**
 * The user for a Google identity, creating them and their tenant if new.
 *
 * One transaction: a tenant with no user in it would be an orphan nobody can
 * reach, and a user with no tenant cannot be given one afterwards without
 * guessing.
 *
 * Matching is on the provider **subject**, never on the email address. Google
 * subjects are stable; email addresses are renamed, reassigned within a
 * workspace, and - for an unverified address - not proof of anything at all.
 * Matching on email is how one person ends up in somebody else's account.
 */
export async function findOrCreateGoogleUser(params: {
  subject: string;
  email: string | null;
}): Promise<User> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: existing } = await client.query(
      `SELECT id, tenant_id, provider, email FROM users
        WHERE provider = 'google' AND provider_subject = $1`,
      [params.subject],
    );

    if (existing[0]) {
      // The address can change on Google's side; the subject cannot. Keep ours
      // current so the UI shows what they would expect to see.
      await client.query(`UPDATE users SET email = $2, last_seen_at = now() WHERE id = $1`, [
        existing[0].id,
        params.email,
      ]);
      await client.query("COMMIT");
      return {
        id: existing[0].id,
        tenantId: asTenantId(existing[0].tenant_id),
        provider: "google",
        email: params.email,
      };
    }

    const tenantId = randomUUID();
    const userId = randomUUID();
    const label = params.email ?? `google-${params.subject.slice(0, 8)}`;

    await client.query(
      `INSERT INTO tenants (id, slug, display_name) VALUES ($1, $2, $3)`,
      // The slug is derived but made unique by the id: two people at the same
      // company have the same domain, and a collision here would fail a
      // signup for a reason that has nothing to do with them.
      [tenantId, `t-${tenantId.slice(0, 8)}`, label],
    );

    await client.query(
      `INSERT INTO users (id, tenant_id, provider, provider_subject, email, last_seen_at)
       VALUES ($1, $2, 'google', $3, $4, now())`,
      [userId, tenantId, params.subject, params.email],
    );

    await client.query("COMMIT");
    return { id: userId, tenantId: asTenantId(tenantId), provider: "google", email: params.email };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getUser(userId: string): Promise<User | null> {
  const { rows } = await pool.query(
    `SELECT id, tenant_id, provider, email FROM users WHERE id = $1`,
    [userId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    tenantId: asTenantId(row.tenant_id),
    provider: row.provider,
    email: row.email,
  };
}
