/**
 * Reading and writing scans.
 *
 * Writes are batched and wrapped in a transaction: a scan is either entirely
 * persisted or not at all. A half-written scan would be worse than no scan,
 * because the UI would present it as complete.
 */

import { randomUUID } from "node:crypto";
import type {
  Relationship,
  Resource,
  ResourceDiff,
  ScanDiff,
  ScanRun,
  ScanStatus,
  ScanUnit,
} from "@daveio/shared";

import { fingerprint, pool } from "./postgres.js";
import type { TenantId } from "../tenancy/tenant.js";

/** Rows per INSERT. Postgres caps parameters at 65535; this stays well under. */
const BATCH_SIZE = 500;

const GLOBAL = "global";

export async function createScanRun(
  tenantId: TenantId,
  accountId: string,
  regions: string[],
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO scan_runs (id, tenant_id, account_id, status, started_at, regions)
     VALUES ($1, $2, $3, 'running', now(), $4)`,
    [id, tenantId, accountId, regions],
  );
  return id;
}

export async function failScanRun(
  tenantId: TenantId,
  scanId: string,
  error: string,
): Promise<void> {
  await pool.query(
    `UPDATE scan_runs SET status = 'failed', finished_at = now(), error = $3
     WHERE id = $1 AND tenant_id = $2`,
    [scanId, tenantId, error],
  );
}

/** Persist a completed scan: units, resources and relationships, atomically. */
export async function saveScanResult(
  tenantId: TenantId,
  scanId: string,
  params: {
    status: ScanStatus;
    units: ScanUnit[];
    resources: Resource[];
    relationships: Relationship[];
    apiCalls: number;
  },
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const unit of params.units) {
      await client.query(
        `INSERT INTO scan_units
           (tenant_id, scan_id, service, region, status, resource_count, api_calls, duration_ms, error, error_code, started_at, finished_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (scan_id, service, region) DO UPDATE SET
           status = EXCLUDED.status, resource_count = EXCLUDED.resource_count,
           api_calls = EXCLUDED.api_calls, duration_ms = EXCLUDED.duration_ms,
           error = EXCLUDED.error, error_code = EXCLUDED.error_code`,
        [
          tenantId,
          scanId,
          unit.service,
          unit.region ?? GLOBAL,
          unit.status,
          unit.resourceCount,
          unit.apiCalls,
          unit.durationMs,
          unit.error ?? null,
          unit.errorCode ?? null,
          unit.startedAt ?? null,
          unit.finishedAt ?? null,
        ],
      );
    }

    for (let i = 0; i < params.resources.length; i += BATCH_SIZE) {
      const batch = params.resources.slice(i, i + BATCH_SIZE);
      const values: unknown[] = [];
      const tuples = batch.map((r, n) => {
        const b = n * 11;
        values.push(
          tenantId,
          scanId,
          r.arn,
          r.kind,
          r.name,
          r.region,
          r.accountId,
          JSON.stringify(r.tags),
          JSON.stringify(r.properties),
          JSON.stringify(r.derived),
          fingerprint(r),
        );
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11})`;
      });
      await client.query(
        `INSERT INTO resource_snapshots
           (tenant_id, scan_id, arn, kind, name, region, account_id, tags, properties, derived, fingerprint)
         VALUES ${tuples.join(",")}
         ON CONFLICT (scan_id, arn) DO NOTHING`,
        values,
      );
    }

    for (let i = 0; i < params.relationships.length; i += BATCH_SIZE) {
      const batch = params.relationships.slice(i, i + BATCH_SIZE);
      const values: unknown[] = [];
      const tuples = batch.map((rel, n) => {
        const b = n * 6;
        values.push(
          tenantId,
          scanId,
          rel.from,
          rel.to,
          rel.type,
          JSON.stringify(rel.properties ?? {}),
        );
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6})`;
      });
      await client.query(
        `INSERT INTO relationship_snapshots (tenant_id, scan_id, from_arn, to_arn, rel_type, properties)
         VALUES ${tuples.join(",")}`,
        values,
      );
    }

    await client.query(
      `UPDATE scan_runs
         SET status = $2, finished_at = now(), resource_count = $3,
             relationship_count = $4, api_calls = $5
       WHERE id = $1`,
      [
        scanId,
        params.status,
        params.resources.length,
        params.relationships.length,
        params.apiCalls,
      ],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

interface ScanRow {
  id: string;
  account_id: string;
  status: ScanStatus;
  started_at: Date;
  finished_at: Date | null;
  regions: string[];
  resource_count: number;
  relationship_count: number;
  error: string | null;
}

function toScanRun(row: ScanRow, units: ScanUnit[]): ScanRun {
  return {
    id: row.id,
    accountId: row.account_id,
    status: row.status,
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
    regions: row.regions,
    units,
    resourceCount: row.resource_count,
    relationshipCount: row.relationship_count,
    ...(row.error ? { error: row.error } : {}),
  };
}

async function unitsFor(scanIds: string[]): Promise<Map<string, ScanUnit[]>> {
  if (scanIds.length === 0) return new Map();
  const { rows } = await pool.query(
    `SELECT * FROM scan_units WHERE scan_id = ANY($1) ORDER BY service, region`,
    [scanIds],
  );
  const map = new Map<string, ScanUnit[]>();
  for (const row of rows) {
    const unit: ScanUnit = {
      service: row.service,
      region: row.region === GLOBAL ? null : row.region,
      status: row.status,
      resourceCount: row.resource_count,
      apiCalls: row.api_calls,
      durationMs: row.duration_ms,
      ...(row.error ? { error: row.error } : {}),
      ...(row.error_code ? { errorCode: row.error_code } : {}),
      ...(row.started_at ? { startedAt: row.started_at.toISOString() } : {}),
      ...(row.finished_at ? { finishedAt: row.finished_at.toISOString() } : {}),
    };
    (map.get(row.scan_id) ?? map.set(row.scan_id, []).get(row.scan_id)!).push(unit);
  }
  return map;
}

export async function listScans(tenantId: TenantId, limit = 20): Promise<ScanRun[]> {
  const { rows } = await pool.query<ScanRow>(
    `SELECT * FROM scan_runs WHERE tenant_id = $1 ORDER BY started_at DESC LIMIT $2`,
    [tenantId, limit],
  );
  const units = await unitsFor(rows.map((r) => r.id));
  return rows.map((row) => toScanRun(row, units.get(row.id) ?? []));
}

export async function getScan(tenantId: TenantId, scanId: string): Promise<ScanRun | null> {
  const { rows } = await pool.query<ScanRow>(
    `SELECT * FROM scan_runs WHERE id = $1 AND tenant_id = $2`,
    [scanId, tenantId],
  );
  const row = rows[0];
  if (!row) return null;
  const units = await unitsFor([row.id]);
  return toScanRun(row, units.get(row.id) ?? []);
}

/** The most recent scan that produced usable data. */
export async function getLatestScan(tenantId: TenantId): Promise<ScanRun | null> {
  const { rows } = await pool.query<ScanRow>(
    `SELECT * FROM scan_runs
      WHERE tenant_id = $1 AND status IN ('succeeded','partial')
      ORDER BY started_at DESC LIMIT 1`,
    [tenantId],
  );
  const row = rows[0];
  if (!row) return null;
  const units = await unitsFor([row.id]);
  return toScanRun(row, units.get(row.id) ?? []);
}

export async function loadResources(tenantId: TenantId, scanId: string): Promise<Resource[]> {
  const { rows } = await pool.query(
    `SELECT arn, kind, name, region, account_id, tags, properties, derived
       FROM resource_snapshots WHERE scan_id = $1 AND tenant_id = $2`,
    [scanId, tenantId],
  );
  return rows.map((r) => ({
    arn: r.arn,
    kind: r.kind,
    name: r.name,
    region: r.region,
    accountId: r.account_id,
    tags: r.tags,
    properties: r.properties,
    derived: r.derived,
  }));
}

export async function loadRelationships(
  tenantId: TenantId,
  scanId: string,
): Promise<Relationship[]> {
  const { rows } = await pool.query(
    `SELECT from_arn, to_arn, rel_type, properties
       FROM relationship_snapshots WHERE scan_id = $1 AND tenant_id = $2`,
    [scanId, tenantId],
  );
  return rows.map((r) => ({
    from: r.from_arn,
    to: r.to_arn,
    type: r.rel_type,
    properties: r.properties,
  }));
}

/**
 * What changed between two scans.
 *
 * Added and removed are set differences on ARN. Modified is a fingerprint
 * mismatch, and only then are the two JSONB blobs compared field by field -
 * so the expensive comparison runs on the handful of rows that actually
 * differ rather than on the whole inventory.
 */
export async function diffScans(
  tenantId: TenantId,
  fromScanId: string,
  toScanId: string,
): Promise<ScanDiff> {
  /**
   * Both scans are fetched tenant-scoped **before** any comparison runs, so a
   * scan id belonging to another tenant fails here as "does not exist" rather
   * than being diffed against one of ours. That is the whole defence: the
   * queries below take scan ids, and an id is not evidence of ownership.
   */
  const [fromRun, toRun] = await Promise.all([
    getScan(tenantId, fromScanId),
    getScan(tenantId, toScanId),
  ]);
  if (!fromRun || !toRun) throw new Error("One or both scans do not exist");

  const { rows: added } = await pool.query(
    `SELECT arn, kind, name FROM resource_snapshots t
      WHERE t.scan_id = $2
        AND NOT EXISTS (SELECT 1 FROM resource_snapshots f WHERE f.scan_id = $1 AND f.arn = t.arn)
      ORDER BY kind, name`,
    [fromScanId, toScanId],
  );

  const { rows: removed } = await pool.query(
    `SELECT arn, kind, name FROM resource_snapshots f
      WHERE f.scan_id = $1
        AND NOT EXISTS (SELECT 1 FROM resource_snapshots t WHERE t.scan_id = $2 AND t.arn = f.arn)
      ORDER BY kind, name`,
    [fromScanId, toScanId],
  );

  const { rows: changed } = await pool.query(
    `SELECT f.arn, t.kind, t.name,
            f.properties AS before_props, t.properties AS after_props,
            f.derived    AS before_derived, t.derived    AS after_derived
       FROM resource_snapshots f
       JOIN resource_snapshots t ON t.arn = f.arn AND t.scan_id = $2
      WHERE f.scan_id = $1 AND f.fingerprint <> t.fingerprint
      ORDER BY t.kind, t.name`,
    [fromScanId, toScanId],
  );

  const modified: ResourceDiff[] = changed.map((row) => ({
    arn: row.arn,
    kind: row.kind,
    name: row.name,
    change: "modified" as const,
    changedFields: [
      ...changedFields(row.before_props, row.after_props, ""),
      ...changedFields(row.before_derived, row.after_derived, "derived."),
    ],
  }));

  return {
    fromScanId,
    toScanId,
    fromScanAt: fromRun.startedAt,
    toScanAt: toRun.startedAt,
    added: added.map((r) => ({ ...r, change: "added" as const })),
    removed: removed.map((r) => ({ ...r, change: "removed" as const })),
    modified,
  };
}

/** Top-level field comparison. Nested objects are compared as wholes. */
function changedFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  prefix: string,
): Array<{ field: string; before: unknown; after: unknown }> {
  const fields: Array<{ field: string; before: unknown; after: unknown }> = [];
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const key of keys) {
    const a = before?.[key];
    const b = after?.[key];
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      // `undefined` is dropped entirely by JSON.stringify, so a field that
      // only appeared in the newer scan would serialise with no `before` key
      // at all and every consumer would have to handle its absence. Normalised
      // to null so both keys are always present over the wire.
      fields.push({ field: `${prefix}${key}`, before: a ?? null, after: b ?? null });
    }
  }
  return fields;
}
