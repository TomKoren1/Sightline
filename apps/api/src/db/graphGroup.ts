/**
 * Which group a large account's graph shows each resource in: the VPC it is in
 * - directly, through its subnet, or for a VPC itself - or else its kind.
 *
 * Decided when a scan is written, from the relationships already in memory,
 * and stored on the snapshot: reading the groups by joining every edge took
 * two seconds a request at 150,000 resources. `backfillSql` is the same rule
 * in SQL, for scans written before the column existed.
 */

import { sql, type SQL } from "drizzle-orm";
import type { Relationship, Resource } from "@sightline/shared";

/** Synthetic nodes, which belong to no group. */
const UNGROUPED = new Set(["Internet", "Region", "Account"]);

export function graphGroups(
  resources: readonly Pick<Resource, "arn" | "kind">[],
  relationships: readonly Relationship[],
): Map<string, string> {
  const vpcOf = new Map<string, string>();
  const subnetsOf = new Map<string, string[]>();
  for (const e of relationships) {
    if (e.type === "IN_VPC" && !vpcOf.has(e.from)) vpcOf.set(e.from, e.to);
    if (e.type === "IN_SUBNET") {
      const list = subnetsOf.get(e.from);
      if (list) list.push(e.to);
      else subnetsOf.set(e.from, [e.to]);
    }
  }
  const groups = new Map<string, string>();
  for (const r of resources) {
    if (UNGROUPED.has(r.kind)) continue;
    const vpc =
      vpcOf.get(r.arn) ??
      subnetsOf
        .get(r.arn)
        ?.map((s) => vpcOf.get(s))
        .find((v) => v !== undefined) ??
      (r.kind === "Vpc" ? r.arn : undefined);
    groups.set(r.arn, vpc ? `vpc:${vpc}` : `kind:${r.kind}`);
  }
  return groups;
}

/** Fills in one scan's groups by the same rule, for a scan written before them. */
export function backfillSql(tenantId: string, scanId: string): SQL {
  const edges = sql`(SELECT * FROM relationship_snapshots
    WHERE tenant_id = ${tenantId} AND scan_id = ${scanId})`;
  return sql`
    UPDATE resource_snapshots t SET graph_group = m."group"
      FROM (
        SELECT DISTINCT ON (r.arn) r.arn,
               CASE WHEN coalesce(v.to_arn, sv.to_arn, CASE WHEN r.kind = 'Vpc' THEN r.arn END) IS NOT NULL
                    THEN 'vpc:' || coalesce(v.to_arn, sv.to_arn, r.arn)
                    ELSE 'kind:' || r.kind END AS "group"
          FROM resource_snapshots r
          LEFT JOIN ${edges} v ON v.from_arn = r.arn AND v.rel_type = 'IN_VPC'
          LEFT JOIN ${edges} s ON s.from_arn = r.arn AND s.rel_type = 'IN_SUBNET'
          LEFT JOIN ${edges} sv ON sv.from_arn = s.to_arn AND sv.rel_type = 'IN_VPC'
         WHERE r.tenant_id = ${tenantId} AND r.scan_id = ${scanId}
           AND r.kind NOT IN ('Internet', 'Region', 'Account')
         ORDER BY r.arn
      ) m
     WHERE t.tenant_id = ${tenantId} AND t.scan_id = ${scanId} AND t.arn = m.arn`;
}
