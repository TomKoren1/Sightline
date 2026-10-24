/**
 * Reading and writing scans.
 *
 * Writes are batched and wrapped in a transaction: a scan is either entirely
 * persisted or not at all. A half-written scan would be worse than no scan,
 * because the UI would present it as complete.
 */

import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Relationship, Resource, ScanRun, ScanStatus, ScanUnit } from "@sightline/shared";

import { db, fingerprint, system, withTenant, type Database } from "./postgres.js";
import {
  documentRefs,
  extractDocuments,
  restoreDocuments,
  selectDocuments,
  upsertDocuments,
} from "./policyDocuments.js";
import { graphGroups } from "./graphGroup.js";

/**
 * Anything that can run a write: the pool, or a transaction on it.
 *
 * Derived from `db.transaction`'s own callback rather than written out, because
 * Drizzle's transaction type carries several generic parameters that have to
 * match the schema exactly - naming them by hand is a type that compiles today
 * and stops matching the moment the schema gains a table.
 */
type Writer = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];
import { relationshipSnapshots, resourceSnapshots, scanRuns, scanUnits } from "./schema.js";
import type { ScanId } from "../core/ids.js";
import type { Scope } from "../core/scope.js";

/**
 * Reads are filtered on the tenant as well as on the scan id.
 *
 * A scan id is a uuid and therefore unguessable, which is an argument for
 * convenience and not for safety: the id can also arrive from a stale page, a
 * copied link or a bug, and "unguessable" is not the same as "checked". Every
 * read names the tenant, so a scan belonging to someone else returns nothing
 * rather than returning their inventory.
 */
const ownedScan = (scope: Scope, scanId: string) =>
  and(eq(scanRuns.id, scanId), eq(scanRuns.tenantId, scope.tenantId));

/**
 * Rows per snapshot INSERT.
 *
 * Each batch travels as one JSON parameter that `json_to_recordset` unpacks,
 * rather than Drizzle's ten parameters a row: no parameter cap to respect, and
 * none of the per-value query building that was most of the save's CPU. A
 * batch's JSON is a few MB at this size.
 */
const BATCH_SIZE = 2000;

function insertResourceSnapshots(tenantId: string, scanId: string, rows: object[]) {
  return sql`
    INSERT INTO resource_snapshots
           (tenant_id, scan_id, arn, kind, name, region, account_id, tags, properties, derived,
            fingerprint, graph_group)
    SELECT ${tenantId}::uuid, ${scanId}::uuid,
           r.arn, r.kind, r.name, r.region, r.account_id, r.tags, r.properties, r.derived,
           r.fingerprint, r.graph_group
      FROM json_to_recordset(${JSON.stringify(rows)}::json)
        AS r(arn text, kind text, name text, region text, account_id text,
             tags jsonb, properties jsonb, derived jsonb, fingerprint text, graph_group text)
    ON CONFLICT (scan_id, arn) DO NOTHING`;
}

function insertRelationshipSnapshots(tenantId: string, scanId: string, rows: object[]) {
  return sql`
    INSERT INTO relationship_snapshots (tenant_id, scan_id, from_arn, to_arn, rel_type, properties)
    SELECT ${tenantId}::uuid, ${scanId}::uuid, r.from_arn, r.to_arn, r.rel_type, r.properties
      FROM json_to_recordset(${JSON.stringify(rows)}::json)
        AS r(from_arn text, to_arn text, rel_type text, properties jsonb)`;
}

const GLOBAL = "global";

export async function createScanRun(
  scope: Scope,
  accountId: string,
  regions: string[],
): Promise<ScanId> {
  return withTenant(scope.tenantId, async () => {
    const id = randomUUID();
    await db.insert(scanRuns).values({
      id,
      tenantId: scope.tenantId,
      connectionId: scope.connectionId,
      accountId,
      status: "running",
      startedAt: new Date(),
      regions,
    });
    return id as ScanId;
  });
}

export async function failScanRun(scope: Scope, scanId: string, error: string): Promise<void> {
  return withTenant(scope.tenantId, async () => {
    await db
      .update(scanRuns)
      .set({ status: "failed", finishedAt: new Date(), error })
      .where(ownedScan(scope, scanId));
  });
}

/**
 * Make this scan the one its connection reads.
 *
 * The flip in write-then-flip, and deliberately one statement: the scan's
 * snapshots have already committed by the time this runs, so there is no
 * window in which a reader sees a half-written graph, and a save that failed
 * simply never gets here.
 */
export async function markProjected(scope: Scope, scanId: string): Promise<void> {
  return withTenant(scope.tenantId, async () => {
    await db.update(scanRuns).set({ projectedAt: new Date() }).where(ownedScan(scope, scanId));
  });
}

/**
 * Delete this account's finished scans beyond the newest `keep`.
 *
 * Snapshots, units and relationships go with them by cascade; conversations
 * and jobs keep their rows with the scan id cleared. The two most recent
 * projected scans are never deleted whatever their age, because a reader may
 * be on either, and a running scan is never touched.
 */
export async function pruneScanHistory(scope: Scope, keep: number): Promise<number> {
  return withTenant(scope.tenantId, async () => {
    const { rows } = await db.execute<{ id: string }>(sql`
      DELETE FROM scan_runs
      WHERE tenant_id = ${scope.tenantId}
        AND connection_id = ${scope.connectionId}
        AND status <> 'running'
        AND id NOT IN (
          SELECT id FROM scan_runs
          WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId}
          ORDER BY started_at DESC
          LIMIT ${keep}
        )
        AND id NOT IN (
          SELECT id FROM scan_runs
          WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId}
            AND projected_at IS NOT NULL
          ORDER BY projected_at DESC
          LIMIT 2
        )
      RETURNING id
    `);
    if (rows.length > 0) {
      // Documents no retained scan can refer to: every save marks the ones it
      // uses, so anything last used before the oldest remaining scan began is
      // referenced by nothing. Across the tenant, because documents are shared
      // by all of its accounts. An hour's margin, because the two times come
      // from different clocks - `started_at` the app's, `last_used_at` the
      // database's - and an app clock running ahead would otherwise delete a
      // document a retained scan still refers to. Late deletion costs nothing.
      await db.execute(sql`
        DELETE FROM policy_documents
         WHERE tenant_id = ${scope.tenantId}
           AND last_used_at < (SELECT min(started_at) FROM scan_runs
                                WHERE tenant_id = ${scope.tenantId}) - interval '1 hour'
      `);
    }
    return rows.length;
  });
}

/**
 * The scan whose graph this connection currently reads, if any.
 *
 * "Latest projected", rather than a pointer kept in step by hand - one fewer
 * thing that can disagree with the graph it names.
 */
export async function currentScanId(scope: Scope): Promise<ScanId | null> {
  return withTenant(scope.tenantId, async () => {
    const [row] = await db
      .select({ id: scanRuns.id })
      .from(scanRuns)
      .where(
        and(
          eq(scanRuns.tenantId, scope.tenantId),
          eq(scanRuns.connectionId, scope.connectionId),
          isNotNull(scanRuns.projectedAt),
        ),
      )
      .orderBy(desc(scanRuns.projectedAt))
      .limit(1);
    return (row?.id as ScanId | undefined) ?? null;
  });
}

/**
 * Write one unit's current state.
 *
 * Shared by the incremental path - the worker calling this as each unit starts
 * and finishes, which is what a reloaded page reads its progress from - and by
 * `saveScanResult`, which writes the final set. One function rather than two
 * similar ones on purpose: they must agree about the `'global'` sentinel and
 * about which columns an upsert overwrites, and two copies of that agreement is
 * one copy too many.
 *
 * An upsert, so the order of "all pending", "this one running" and "this one
 * finished" does not matter and a retried scan overwrites its own earlier
 * attempt rather than conflicting with it.
 */
async function writeScanUnit(
  tx: Writer,
  scope: Scope,
  scanId: string,
  unit: ScanUnit,
): Promise<void> {
  await tx
    .insert(scanUnits)
    .values({
      tenantId: scope.tenantId,
      scanId,
      service: unit.service,
      // 'global' rather than NULL, so a non-regional service can take part
      // in the primary key.
      region: unit.region ?? GLOBAL,
      status: unit.status,
      resourceCount: unit.resourceCount,
      apiCalls: unit.apiCalls,
      durationMs: unit.durationMs,
      error: unit.error ?? null,
      errorCode: unit.errorCode ?? null,
      startedAt: unit.startedAt ? new Date(unit.startedAt) : null,
      finishedAt: unit.finishedAt ? new Date(unit.finishedAt) : null,
    })
    .onConflictDoUpdate({
      target: [scanUnits.scanId, scanUnits.service, scanUnits.region],
      set: {
        status: sql`excluded.status`,
        resourceCount: sql`excluded.resource_count`,
        apiCalls: sql`excluded.api_calls`,
        durationMs: sql`excluded.duration_ms`,
        error: sql`excluded.error`,
        errorCode: sql`excluded.error_code`,
        startedAt: sql`excluded.started_at`,
        finishedAt: sql`excluded.finished_at`,
      },
    });
}

/**
 * Write the whole plan as pending, before any of it has run.
 *
 * So that a page joining a scan already in flight sees every service the scan
 * intends to read rather than a list growing from empty - the same reason the
 * runner builds its unit list up front. One statement rather than one per unit,
 * because this is on the critical path before any work starts.
 */
export async function startScanUnits(
  scope: Scope,
  scanId: string,
  units: ScanUnit[],
): Promise<void> {
  return withTenant(scope.tenantId, async () => {
    if (units.length === 0) return;
    await db
      .insert(scanUnits)
      .values(
        units.map((unit) => ({
          tenantId: scope.tenantId,
          scanId,
          service: unit.service,
          region: unit.region ?? GLOBAL,
          status: unit.status,
          resourceCount: unit.resourceCount,
          apiCalls: unit.apiCalls,
          durationMs: unit.durationMs,
        })),
      )
      .onConflictDoNothing({ target: [scanUnits.scanId, scanUnits.service, scanUnits.region] });
  });
}

/** Update one unit as it starts or finishes, so progress is readable from SQL. */
export async function recordScanUnit(scope: Scope, scanId: string, unit: ScanUnit): Promise<void> {
  return withTenant(scope.tenantId, async () => {
    await writeScanUnit(db, scope, scanId, unit);
  });
}

/**
 * Persist a completed scan: resources and relationships in short batches,
 * then units and status together.
 *
 * Not one transaction. At 150,000 resources that held a transaction open for
 * 85 seconds - WAL that cannot be recycled and a vacuum that cannot clean -
 * on the path of every other tenant's writes. Batches commit as they go, and
 * nothing reads them early: the graph reads projected scans and history reads
 * finished ones, and until the last statement this scan is neither. A save
 * that fails removes what it wrote, so a failed scan leaves no rows behind.
 */
export async function saveScanResult(
  scope: Scope,
  scanId: string,
  params: {
    status: ScanStatus;
    units: ScanUnit[];
    resources: Resource[];
    relationships: Relationship[];
    apiCalls: number;
  },
): Promise<void> {
  const groups = graphGroups(params.resources, params.relationships);
  return withTenant(scope.tenantId, async () => {
    try {
      for (let i = 0; i < params.resources.length; i += BATCH_SIZE) {
        const batch = params.resources.slice(i, i + BATCH_SIZE);
        await db.transaction(async (tx) => {
          // Documents first, so no snapshot ever refers to one not yet stored.
          const extracted = batch.map((r) => extractDocuments(r));
          const documents = new Map(extracted.flatMap((e) => [...e.documents]));
          if (documents.size > 0) await tx.execute(upsertDocuments(scope.tenantId, documents));
          await tx.execute(
            insertResourceSnapshots(
              scope.tenantId,
              scanId,
              batch.map((r, j) => ({
                arn: r.arn,
                kind: r.kind,
                name: r.name,
                region: r.region,
                account_id: r.accountId,
                tags: r.tags,
                properties: extracted[j]!.properties,
                derived: r.derived,
                // Of the resource as collected: a document's content, not where
                // it is stored, is what makes two scans of a role differ.
                fingerprint: fingerprint(r),
                graph_group: groups.get(r.arn) ?? null,
              })),
            ),
          );
        });
      }

      for (let i = 0; i < params.relationships.length; i += BATCH_SIZE) {
        const batch = params.relationships.slice(i, i + BATCH_SIZE);
        await db.execute(
          insertRelationshipSnapshots(
            scope.tenantId,
            scanId,
            batch.map((rel) => ({
              from_arn: rel.from,
              to_arn: rel.to,
              rel_type: rel.type,
              properties: rel.properties ?? {},
            })),
          ),
        );
      }

      // The publish: until this commits the scan is still running, and unread.
      await db.transaction(async (tx) => {
        for (const unit of params.units) {
          await writeScanUnit(tx, scope, scanId, unit);
        }
        await tx
          .update(scanRuns)
          .set({
            status: params.status,
            finishedAt: new Date(),
            resourceCount: params.resources.length,
            relationshipCount: params.relationships.length,
            apiCalls: params.apiCalls,
          })
          .where(ownedScan(scope, scanId));
      });
    } catch (err) {
      await discardSnapshots(scope, scanId).catch(() => undefined);
      throw err;
    }
  });
}

/** What a failed save wrote. Documents stay: they are shared, and pruned by reference. */
async function discardSnapshots(scope: Scope, scanId: string): Promise<void> {
  await db
    .delete(relationshipSnapshots)
    .where(
      and(
        eq(relationshipSnapshots.tenantId, scope.tenantId),
        eq(relationshipSnapshots.scanId, scanId),
      ),
    );
  await db
    .delete(resourceSnapshots)
    .where(
      and(eq(resourceSnapshots.tenantId, scope.tenantId), eq(resourceSnapshots.scanId, scanId)),
    );
}

type ScanRow = typeof scanRuns.$inferSelect;

function toScanRun(row: ScanRow, units: ScanUnit[]): ScanRun {
  return {
    id: row.id,
    accountId: row.accountId,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    regions: row.regions,
    units,
    resourceCount: row.resourceCount,
    relationshipCount: row.relationshipCount,
    ...(row.error ? { error: row.error } : {}),
  };
}

async function unitsFor(scope: Scope, scanIds: string[]): Promise<Map<string, ScanUnit[]>> {
  if (scanIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(scanUnits)
    .where(and(inArray(scanUnits.scanId, scanIds), eq(scanUnits.tenantId, scope.tenantId)))
    .orderBy(asc(scanUnits.service), asc(scanUnits.region));

  const map = new Map<string, ScanUnit[]>();
  for (const row of rows) {
    const unit: ScanUnit = {
      service: row.service,
      region: row.region === GLOBAL ? null : row.region,
      status: row.status,
      resourceCount: row.resourceCount,
      apiCalls: row.apiCalls,
      durationMs: row.durationMs,
      ...(row.error ? { error: row.error } : {}),
      ...(row.errorCode ? { errorCode: row.errorCode } : {}),
      ...(row.startedAt ? { startedAt: row.startedAt.toISOString() } : {}),
      ...(row.finishedAt ? { finishedAt: row.finishedAt.toISOString() } : {}),
    };
    (map.get(row.scanId) ?? map.set(row.scanId, []).get(row.scanId)!).push(unit);
  }
  return map;
}

/**
 * Refresh the planner's statistics on the snapshot tables after a large write.
 *
 * A scan of tens of thousands of resources arrives faster than autovacuum
 * notices it, and until it does the planner believes the new scan holds a row
 * or two - so it chooses nested loops that rescan the scan for every edge. The
 * open-security-group panel took 26 seconds on a fresh 50,000-resource scan
 * and 39 milliseconds after `ANALYZE`. Sampled, so it costs well under a
 * second whatever the table's size.
 *
 * On the owner connection: `ANALYZE` is the table owner's to run, and the
 * statistics are about the table rather than any tenant's rows - housekeeping,
 * in `system`'s terms. Never fatal: stale statistics make a query slow, not
 * wrong, and a scan that is already saved must not fail over it.
 */
export async function refreshSnapshotStatistics(): Promise<void> {
  try {
    await system.execute(sql`SELECT refresh_snapshot_statistics()`);
  } catch (err) {
    console.warn(
      "Refreshing snapshot statistics failed; queries may plan badly until autovacuum runs:",
      err,
    );
  }
}

/** A scan large enough that the planner's view of the tables is out of date. */
export const STATISTICS_REFRESH_THRESHOLD = 5_000;

export async function listScans(scope: Scope, limit = 20): Promise<ScanRun[]> {
  return withTenant(scope.tenantId, async () => {
    const rows = await db
      .select()
      .from(scanRuns)
      .where(
        and(eq(scanRuns.tenantId, scope.tenantId), eq(scanRuns.connectionId, scope.connectionId)),
      )
      .orderBy(desc(scanRuns.startedAt))
      .limit(limit);
    const units = await unitsFor(
      scope,
      rows.map((r) => r.id),
    );
    return rows.map((row) => toScanRun(row, units.get(row.id) ?? []));
  });
}

export async function getScan(scope: Scope, scanId: ScanId): Promise<ScanRun | null> {
  return withTenant(scope.tenantId, async () => {
    const [row] = await db.select().from(scanRuns).where(ownedScan(scope, scanId));
    if (!row) return null;
    const units = await unitsFor(scope, [row.id]);
    return toScanRun(row, units.get(row.id) ?? []);
  });
}

/** The most recent scan of this connection that produced usable data. */
export async function getLatestScan(scope: Scope): Promise<ScanRun | null> {
  return withTenant(scope.tenantId, async () => {
    const [row] = await db
      .select()
      .from(scanRuns)
      .where(
        and(
          eq(scanRuns.tenantId, scope.tenantId),
          eq(scanRuns.connectionId, scope.connectionId),
          inArray(scanRuns.status, ["succeeded", "partial"]),
        ),
      )
      .orderBy(desc(scanRuns.startedAt))
      .limit(1);
    if (!row) return null;
    const units = await unitsFor(scope, [row.id]);
    return toScanRun(row, units.get(row.id) ?? []);
  });
}

export async function loadResources(scope: Scope, scanId: string): Promise<Resource[]> {
  return withTenant(scope.tenantId, async () => {
    const rows = await db
      .select({
        arn: resourceSnapshots.arn,
        kind: resourceSnapshots.kind,
        name: resourceSnapshots.name,
        region: resourceSnapshots.region,
        accountId: resourceSnapshots.accountId,
        tags: resourceSnapshots.tags,
        properties: resourceSnapshots.properties,
        derived: resourceSnapshots.derived,
      })
      .from(resourceSnapshots)
      .where(
        and(eq(resourceSnapshots.scanId, scanId), eq(resourceSnapshots.tenantId, scope.tenantId)),
      );
    return withDocuments(scope.tenantId, rows);
  });
}

/** Put stored policy documents back into snapshots that refer to them. */
export async function withDocuments<T extends { properties: Resource["properties"] }>(
  tenantId: string,
  rows: T[],
): Promise<T[]> {
  const hashes = [...new Set(rows.flatMap((r) => documentRefs(r.properties)))];
  if (hashes.length === 0) return rows;
  const { rows: found } = await db.execute<{ hash: string; document: unknown }>(
    selectDocuments(tenantId, hashes),
  );
  const documents = new Map(found.map((d) => [d.hash, d.document]));
  return rows.map((r) => ({ ...r, properties: restoreDocuments(r.properties, documents) }));
}

export async function loadRelationships(scope: Scope, scanId: string): Promise<Relationship[]> {
  return withTenant(scope.tenantId, async () => {
    const rows = await db
      .select({
        from: relationshipSnapshots.fromArn,
        to: relationshipSnapshots.toArn,
        type: relationshipSnapshots.relType,
        properties: relationshipSnapshots.properties,
      })
      .from(relationshipSnapshots)
      .where(
        and(
          eq(relationshipSnapshots.scanId, scanId),
          eq(relationshipSnapshots.tenantId, scope.tenantId),
        ),
      );
    return rows;
  });
}
