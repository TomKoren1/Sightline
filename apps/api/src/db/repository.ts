/**
 * Reading and writing scans.
 *
 * Writes are batched and wrapped in a transaction: a scan is either entirely
 * persisted or not at all. A half-written scan would be worse than no scan,
 * because the UI would present it as complete.
 */

import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, ne, notExists, sql } from "drizzle-orm";
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

import { db, fingerprint } from "./postgres.js";
import { relationshipSnapshots, resourceSnapshots, scanRuns, scanUnits } from "./schema.js";

/**
 * Rows per INSERT.
 *
 * Drizzle builds one multi-row `INSERT` from the array it is given, so the
 * parameter cap is still ours to respect: Postgres allows 65535 and a resource
 * contributes ten. This stays well under.
 */
const BATCH_SIZE = 500;

const GLOBAL = "global";

export async function createScanRun(accountId: string, regions: string[]): Promise<string> {
  const id = randomUUID();
  await db.insert(scanRuns).values({
    id,
    accountId,
    status: "running",
    startedAt: new Date(),
    regions,
  });
  return id;
}

export async function failScanRun(scanId: string, error: string): Promise<void> {
  await db
    .update(scanRuns)
    .set({ status: "failed", finishedAt: new Date(), error })
    .where(eq(scanRuns.id, scanId));
}

/** Persist a completed scan: units, resources and relationships, atomically. */
export async function saveScanResult(
  scanId: string,
  params: {
    status: ScanStatus;
    units: ScanUnit[];
    resources: Resource[];
    relationships: Relationship[];
    apiCalls: number;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    for (const unit of params.units) {
      await tx
        .insert(scanUnits)
        .values({
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
          },
        });
    }

    for (let i = 0; i < params.resources.length; i += BATCH_SIZE) {
      const batch = params.resources.slice(i, i + BATCH_SIZE);
      await tx
        .insert(resourceSnapshots)
        .values(
          batch.map((r) => ({
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
      .where(eq(scanRuns.id, scanId));
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

async function unitsFor(scanIds: string[]): Promise<Map<string, ScanUnit[]>> {
  if (scanIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(scanUnits)
    .where(inArray(scanUnits.scanId, scanIds))
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

export async function listScans(limit = 20): Promise<ScanRun[]> {
  const rows = await db.select().from(scanRuns).orderBy(desc(scanRuns.startedAt)).limit(limit);
  const units = await unitsFor(rows.map((r) => r.id));
  return rows.map((row) => toScanRun(row, units.get(row.id) ?? []));
}

export async function getScan(scanId: string): Promise<ScanRun | null> {
  const [row] = await db.select().from(scanRuns).where(eq(scanRuns.id, scanId));
  if (!row) return null;
  const units = await unitsFor([row.id]);
  return toScanRun(row, units.get(row.id) ?? []);
}

/** The most recent scan that produced usable data. */
export async function getLatestScan(): Promise<ScanRun | null> {
  const [row] = await db
    .select()
    .from(scanRuns)
    .where(inArray(scanRuns.status, ["succeeded", "partial"]))
    .orderBy(desc(scanRuns.startedAt))
    .limit(1);
  if (!row) return null;
  const units = await unitsFor([row.id]);
  return toScanRun(row, units.get(row.id) ?? []);
}

export async function loadResources(scanId: string): Promise<Resource[]> {
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
    .where(eq(resourceSnapshots.scanId, scanId));
  return rows;
}

export async function loadRelationships(scanId: string): Promise<Relationship[]> {
  const rows = await db
    .select({
      from: relationshipSnapshots.fromArn,
      to: relationshipSnapshots.toArn,
      type: relationshipSnapshots.relType,
      properties: relationshipSnapshots.properties,
    })
    .from(relationshipSnapshots)
    .where(eq(relationshipSnapshots.scanId, scanId));
  return rows;
}

/**
 * What changed between two scans.
 *
 * Added and removed are set differences on ARN. Modified is a fingerprint
 * mismatch, and only then are the two JSONB blobs compared field by field -
 * so the expensive comparison runs on the handful of rows that actually
 * differ rather than on the whole inventory.
 */
export async function diffScans(fromScanId: string, toScanId: string): Promise<ScanDiff> {
  const [fromRun, toRun] = await Promise.all([getScan(fromScanId), getScan(toScanId)]);
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
    .where(and(eq(before.scanId, fromScanId), ne(before.fingerprint, after.fingerprint)))
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
): Array<{ field: string; before: unknown; after: unknown }> {
  const before = (beforeValue ?? {}) as Record<string, unknown>;
  const after = (afterValue ?? {}) as Record<string, unknown>;
  const fields: Array<{ field: string; before: unknown; after: unknown }> = [];
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
