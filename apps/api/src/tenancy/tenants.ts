/**
 * The tenant row itself.
 *
 * Small on purpose: a tenant is an owner of data, not a profile. The one
 * mutable thing on it is whether they are looking at the demo account, which
 * is per-tenant rather than per-process because with several tenants sharing a
 * process a module-level flag means one person's click changes what everybody
 * else sees (ADR-020).
 */

import { pool } from "../db/postgres.js";
import type { TenantId } from "./tenant.js";

export interface Tenant {
  id: TenantId;
  displayName: string;
  demoMode: boolean;
}

export async function getTenant(tenantId: TenantId): Promise<Tenant | null> {
  const { rows } = await pool.query(
    `SELECT id, display_name, demo_mode FROM tenants WHERE id = $1`,
    [tenantId],
  );
  const row = rows[0];
  if (!row) return null;
  return { id: row.id, displayName: row.display_name, demoMode: row.demo_mode };
}

export async function setDemoMode(tenantId: TenantId, demoMode: boolean): Promise<void> {
  await pool.query(`UPDATE tenants SET demo_mode = $2 WHERE id = $1`, [tenantId, demoMode]);
}
