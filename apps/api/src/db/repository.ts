/**
 * Reading and writing scans.
 *
 * Writes are batched and wrapped in a transaction: a scan is either entirely
 * persisted or not at all. A half-written scan would be worse than no scan,
 * because the UI would present it as complete.
 */

import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, ne, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type {
  Relationship,
  Resource,
  ResourceDiff,
  ScanDiff,
  ScanRun,
  ScanStatus,
  ScanUnit,
} from "@sightline/shared";

import { db, fingerprint, withTenant, type Database } from "./postgres.js";

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
import type { ScanId, TenantId } from "../tenancy/ids.js";
import type { Scope } from "../tenancy/scope.js";

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
 * Rows per INSERT.
 *
 * Drizzle builds one multi-row `INSERT` from the array it is given, so the
 * parameter cap is still ours to respect: Postgres allows 65535 and a resource
 * contributes ten. This stays well under.
 */
const BATCH_SIZE = 500;

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
 * Make this scan's graph projection the current one.
 *
 * The flip in write-then-flip, and deliberately one statement: the projection
 * has already committed into its own Neo4j scope by the time this runs, so
 * there is no window in which a reader sees a half-built graph, and a
 * projection that failed simply never gets here.
 */
export async function markProjected(scope: Scope, scanId: string): Promise<void> {
  return withTenant(scope.tenantId, async () => {
    await db.update(scanRuns).set({ projectedAt: new Date() }).where(ownedScan(scope, scanId));
  });
}

/**
 * Every graph scope this tenant still reads, across all of its accounts.
 *
 * The sweep matches on `tenantId`, so what it keeps has to be every
 * connection's current graph. Assembling that list at the call site is what
 * went wrong: a scan passed its own scan id and the previous one, and the sweep
 * deleted the graphs of every other account the tenant had connected - while
 * Postgres went on calling them projected, so those accounts rendered as an
 * empty graph rather than an error.
 *
 * Two per connection, so a request that resolved a scan id just before a flip
 * still finds its graph. Derived here rather than by the caller, so a
 * connection added later is covered without anybody remembering.
 */
export async function projectedScanIdsToKeep(tenantId: TenantId): Promise<string[]> {
  return withTenant(tenantId, async () => {
    const { rows } = await db.execute<{ id: string }>(sql`
      SELECT id FROM (
        SELECT
          id,
          ROW_NUMBER() OVER (PARTITION BY connection_id ORDER BY projected_at DESC) AS recency
        FROM scan_runs
        WHERE tenant_id = ${tenantId} AND projected_at IS NOT NULL
      ) ranked
      WHERE recency <= 2
    `);
    return rows.map((r) => r.id);
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

/** Persist a completed scan: units, resources and relationships, atomically. */
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
  return withTenant(scope.tenantId, async () => {
    await db.transaction(async (tx) => {
      for (const unit of params.units) {
        await writeScanUnit(tx, scope, scanId, unit);
      }

      for (let i = 0; i < params.resources.length; i += BATCH_SIZE) {
        const batch = params.resources.slice(i, i + BATCH_SIZE);
        await tx
          .insert(resourceSnapshots)
          .values(
            batch.map((r) => ({
              tenantId: scope.tenantId,
              scanId,
              arn: r.arn,
              kind: r.kind,
              name: r.name,
              region: r.region,
              accountId: r.accountId,
              tags: r.tags,
              properties: r.properties,
              derived: r.derived,
              fingerprint: fingerprint(r),
            })),
          )
          .onConflictDoNothing({ target: [resourceSnapshots.scanId, resourceSnapshots.arn] });
      }

      for (let i = 0; i < params.relationships.length; i += BATCH_SIZE) {
        const batch = params.relationships.slice(i, i + BATCH_SIZE);
        await tx.insert(relationshipSnapshots).values(
          batch.map((rel) => ({
            tenantId: scope.tenantId,
            scanId,
            fromArn: rel.from,
            toArn: rel.to,
            relType: rel.type,
            properties: rel.properties ?? {},
          })),
        );
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
  });
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
    return rows;
  });
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

/**
 * What changed between two scans.
 *
 * Added and removed are set differences on ARN. Modified is a fingerprint
 * mismatch, and only then are the two JSONB blobs compared field by field -
 * so the expensive comparison runs on the handful of rows that actually
 * differ rather than on the whole inventory.
 */
export async function diffScans(
  scope: Scope,
  fromScanId: ScanId,
  toScanId: ScanId,
): Promise<ScanDiff> {
  return withTenant(scope.tenantId, async () => {
    const [fromRun, toRun] = await Promise.all([
      getScan(scope, fromScanId),
      getScan(scope, toScanId),
    ]);
    // Both lookups are tenant-scoped, so a scan belonging to another tenant is
    // indistinguishable from one that does not exist - which is the right answer
    // to give, and the reason this check is not merely about typos.
    if (!fromRun || !toRun) throw new Error("One or both scans do not exist");

    // The table is joined to itself, so each side needs its own name.
    const before = alias(resourceSnapshots, "f");
    const after = alias(resourceSnapshots, "t");

    const added = await db
      .select({ arn: after.arn, kind: after.kind, name: after.name })
      .from(after)
      .where(
        and(
          eq(after.scanId, toScanId),
          eq(after.tenantId, scope.tenantId),
          notExists(
            db
              .select({ one: sql`1` })
              .from(before)
              .where(and(eq(before.scanId, fromScanId), eq(before.arn, after.arn))),
          ),
        ),
      )
      .orderBy(asc(after.kind), asc(after.name));

    const removed = await db
      .select({ arn: before.arn, kind: before.kind, name: before.name })
      .from(before)
      .where(
        and(
          eq(before.scanId, fromScanId),
          eq(before.tenantId, scope.tenantId),
          notExists(
            db
              .select({ one: sql`1` })
              .from(after)
              .where(and(eq(after.scanId, toScanId), eq(after.arn, before.arn))),
          ),
        ),
      )
      .orderBy(asc(before.kind), asc(before.name));

    const changed = await db
      .select({
        arn: before.arn,
        kind: after.kind,
        name: after.name,
        beforeProps: before.properties,
        afterProps: after.properties,
        beforeDerived: before.derived,
        afterDerived: after.derived,
      })
      .from(before)
      .innerJoin(after, and(eq(after.arn, before.arn), eq(after.scanId, toScanId)))
      .where(
        and(
          eq(before.scanId, fromScanId),
          eq(before.tenantId, scope.tenantId),
          ne(before.fingerprint, after.fingerprint),
        ),
      )
      .orderBy(asc(after.kind), asc(after.name));

    const modified: ResourceDiff[] = changed.map((row) => ({
      arn: row.arn,
      kind: row.kind,
      name: row.name,
      change: "modified" as const,
      changedFields: [
        ...changedFields(row.beforeProps, row.afterProps, ""),
        ...changedFields(row.beforeDerived, row.afterDerived, "derived."),
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
  });
}

/** Top-level field comparison. Nested objects are compared as wholes. */
function changedFields(
  // `object`, not `Record<string, unknown>`: `derived` is now typed as
  // `DerivedFacts` rather than arriving as `any` from the driver, and a named
  // interface has no index signature. Widening here keeps the call sites clean
  // and keeps the typed column, which is the point of the ORM.
  beforeValue: object,
  afterValue: object,
  prefix: string,
): { field: string; before: unknown; after: unknown }[] {
  const before = (beforeValue ?? {}) as Record<string, unknown>;
  const after = (afterValue ?? {}) as Record<string, unknown>;
  const fields: { field: string; before: unknown; after: unknown }[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const a = before[key];
    const b = after[key];
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
