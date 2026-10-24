/** What changed between two scans of the same account, resource by resource. */

import { and, asc, eq, ne, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { ResourceDiff, ScanDiff } from "@sightline/shared";

import type { ScanId } from "../core/ids.js";
import type { Scope } from "../core/scope.js";
import { db, withTenant } from "./postgres.js";
import { getScan } from "./repository.js";
import { resourceSnapshots } from "./schema.js";

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
