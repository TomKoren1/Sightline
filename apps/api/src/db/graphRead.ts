/**
 * How every graph query reads: one tenant's one scan, under row-level security,
 * with every caller-supplied limit bounded.
 */

import { sql, type SQL } from "drizzle-orm";

import { db, withTenant } from "./postgres.js";
import type { ScanId, TenantId } from "../tenancy/ids.js";

/** Which graph a read may touch: one tenant's one scan. */
export interface GraphScope {
  tenantId: TenantId;
  scanId: ScanId;
}

/** Cap every query, so one bad question cannot drag the whole estate back. */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/**
 * Bound a caller-supplied limit. `NaN` is treated as absent: `?limit=abc` once
 * became `LIMIT 0` and told a customer their account was empty.
 */
export const clamp = (n: number | undefined, fallback = DEFAULT_LIMIT) => {
  const requested = Number.isFinite(n) ? n! : fallback;
  return Math.min(Math.max(1, Math.floor(requested)), MAX_LIMIT);
};

export interface ResourceRow {
  arn: string;
  kind: string;
  name: string;
  region: string | null;
  [key: string]: unknown;
}

export async function read<T>(scope: GraphScope, query: (r: SQL, e: SQL) => SQL): Promise<T[]> {
  // `r` and `e` are the scan's resources and edges, already filtered to it.
  const resources = sql`(SELECT * FROM resource_snapshots
    WHERE tenant_id = ${scope.tenantId} AND scan_id = ${scope.scanId})`;
  const edges = sql`(SELECT * FROM relationship_snapshots
    WHERE tenant_id = ${scope.tenantId} AND scan_id = ${scope.scanId})`;
  return withTenant(scope.tenantId, async () => {
    const { rows } = await db.execute(query(resources, edges));
    return rows as T[];
  });
}

/** A verdict from the `derived` column, as the boolean it is or null. */
export const flag = (column: string, key: string) =>
  sql.raw(`(${column}.derived->>'${key}')::boolean`);
