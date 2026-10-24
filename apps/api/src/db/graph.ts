/**
 * The resource graph, read from Postgres.
 *
 * Every question the agent can ask is answered by one of these, written by
 * hand and reviewed; the model chooses which to call and with what arguments.
 * Each returns rows carrying an `arn`, because ARNs are what the agent may cite
 * and what the UI highlights.
 *
 * The graph is the scan's own snapshot rows - there is no second store to
 * project into, reconcile or sweep. Most questions are filters on computed
 * verdicts and are plain SQL; the two that walk `CAN_REACH` load that scan's
 * edges and search them in memory, which is a few thousand edges even on a
 * large account and bounded by hop count and path count either way.
 *
 * Every read runs under the tenant's row-level security *and* names its scan,
 * so a scan id from the wrong tenant returns nothing twice over.
 */

import { sql } from "drizzle-orm";
import { INTERNET_ARN, type Relationship, type Resource } from "@sightline/shared";

import { clamp, flag, read, type GraphScope, type ResourceRow } from "./graphRead.js";
import { db, withTenant } from "./postgres.js";
import { backfillSql } from "./graphGroup.js";
import { withDocuments } from "./repository.js";
import {
  hopsFrom,
  indexReach,
  searchPaths,
  type PathSearchStop,
  type ReachIndex,
} from "../scan/analysers/reachIndex.js";

export type { GraphScope, ResourceRow } from "./graphRead.js";
export {
  findAdminPrincipals,
  findCrossAccountAccess,
  findIdleResources,
  findInstancesInPublicSubnets,
  findOpenSecurityGroups,
  findPublicResources,
  findUnprotectedBuckets,
  findUnusedAccess,
  listResources,
  pageOf,
  searchResources,
  type FinderName,
  type Page,
} from "./finders.js";

/**
 * The flat property bag the UI and remediation read: properties, then derived
 * facts, then tags, with nested values as JSON strings. The shape the graph
 * store used to hold, kept so nothing downstream changes with the store.
 */
export function flattenResource(
  r: Pick<
    Resource,
    "arn" | "kind" | "name" | "region" | "accountId" | "tags" | "properties" | "derived"
  >,
) {
  const out: Record<string, unknown> = {
    arn: r.arn,
    kind: r.kind,
    name: r.name,
    region: r.region,
    accountId: r.accountId,
  };
  for (const [key, value] of Object.entries(r.properties)) out[key] = primitiveOrJson(value);
  for (const [key, value] of Object.entries(r.derived)) out[key] = primitiveOrJson(value);
  out["tagsJson"] = JSON.stringify(r.tags);
  for (const [key, value] of Object.entries(r.tags)) out[`tag_${key}`] = value;
  return out;
}

function primitiveOrJson(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return value;
  if (
    Array.isArray(value) &&
    value.every((v) => ["string", "number", "boolean"].includes(typeof v))
  ) {
    return value;
  }
  return JSON.stringify(value);
}

// --- Lookups ---------------------------------------------------------------

/** Everything known about one resource, plus its immediate neighbours. */
export async function getResource(
  scope: GraphScope,
  arnOrName: string,
): Promise<ResourceRow | null> {
  const [row] = await read<Resource & { account_id: string }>(
    scope,
    (r) => sql`
    SELECT arn, kind, name, region, account_id, tags, properties, derived
      FROM ${r} r
     WHERE arn = ${arnOrName} OR name = ${arnOrName}
     ORDER BY (arn = ${arnOrName}) DESC
     LIMIT 1`,
  );
  if (!row) return null;
  const [resource] = await withTenant(scope.tenantId, () => withDocuments(scope.tenantId, [row]));

  const neighbours = await read<{
    direction: "out" | "in";
    type: string;
    arn: string;
    name: string;
    kind: string;
  }>(
    scope,
    (r, e) => sql`
      SELECT 'out' AS direction, e.rel_type AS type, o.arn, o.name, o.kind
        FROM ${e} e JOIN ${r} o ON o.arn = e.to_arn
       WHERE e.from_arn = ${row.arn}
      UNION
      SELECT 'in' AS direction, e.rel_type AS type, i.arn, i.name, i.kind
        FROM ${e} e JOIN ${r} i ON i.arn = e.from_arn
       WHERE e.to_arn = ${row.arn}`,
  );
  const side = (d: "out" | "in") =>
    neighbours
      .filter((n) => n.direction === d)
      .map(({ type, arn, name, kind }) => ({ type, arn, name, kind }));

  return {
    props: flattenResource({ ...resource!, accountId: row.account_id }),
    arn: row.arn,
    kind: row.kind,
    name: row.name,
    region: row.region,
    outgoing: side("out"),
    incoming: side("in"),
  };
}

/** Edges that mean "that resource is in use by this one" - what a fix's caution counts. */
const USAGE_EDGES = ["EXECUTES_AS", "HAS_INSTANCE_PROFILE", "PROVIDES_ROLE", "ATTACHED_TO"];

/**
 * Every flagged resource, shaped as `getResource` shapes one, for the fix plan.
 * Three queries however many there are, rather than `getResource` per finding.
 * Capped: `limit + 1` are read so the caller can say when it cut the list.
 */
export async function flaggedResources(scope: GraphScope, limit: number) {
  const rows = await read<Resource & { account_id: string }>(
    scope,
    (r) => sql`
    SELECT arn, kind, name, region, account_id, tags, properties, derived
      FROM ${r} r
     WHERE ${flag("r", "isPublic")} OR ${flag("r", "isAdmin")} OR ${flag("r", "isIdle")}
        OR ${flag("r", "isUnprotected")} OR ${flag("r", "isUnused")}
     ORDER BY kind, name, arn
     LIMIT ${limit + 1}`,
  );
  const truncated = rows.length > limit;
  const kept = rows.slice(0, limit);
  if (kept.length === 0) return { resources: [], truncated };
  const restored = await withTenant(scope.tenantId, () => withDocuments(scope.tenantId, kept));
  const arns = kept.map((r) => r.arn);
  const incoming = await read<{
    to: string;
    type: string;
    arn: string;
    name: string;
    kind: string;
  }>(
    scope,
    (r, e) => sql`
      SELECT e.to_arn AS "to", e.rel_type AS type, o.arn, o.name, o.kind
        FROM ${e} e JOIN ${r} o ON o.arn = e.from_arn
       WHERE e.to_arn IN ${arns} AND e.rel_type IN ${USAGE_EDGES}`,
  );
  const usedBy = new Map<string, typeof incoming>();
  for (const edge of incoming) {
    const list = usedBy.get(edge.to);
    if (list) list.push(edge);
    else usedBy.set(edge.to, [edge]);
  }
  return {
    truncated,
    resources: restored.map((resource, i) => ({
      props: flattenResource({ ...resource, accountId: kept[i]!.account_id }),
      arn: resource.arn,
      kind: resource.kind,
      name: resource.name,
      region: resource.region,
      incoming: (usedBy.get(resource.arn) ?? []).map(({ type, arn, name, kind }) => ({
        type,
        arn,
        name,
        kind,
      })),
    })),
  };
}

/** Counts by kind and region - cheap orientation for an opening question. */
export async function summariseAccount(scope: GraphScope) {
  const [byKind, byRegion, flags] = await Promise.all([
    read<{ kind: string; count: number }>(
      scope,
      (r) => sql`
      SELECT kind, count(*)::int AS count FROM ${r} r
       WHERE kind <> 'Internet' GROUP BY kind ORDER BY count DESC, kind`,
    ),
    read<{ region: string; count: number }>(
      scope,
      (r) => sql`
      SELECT region, count(*)::int AS count FROM ${r} r
       WHERE region IS NOT NULL GROUP BY region ORDER BY count DESC, region`,
    ),
    read<{
      publicCount: number;
      adminCount: number;
      idleCount: number;
      idleCost: number;
      unprotectedCount: number;
      unusedCount: number;
    }>(
      scope,
      (r) => sql`
      SELECT count(*) FILTER (WHERE ${flag("r", "isPublic")})::int AS "publicCount",
             count(*) FILTER (WHERE ${flag("r", "isAdmin")})::int AS "adminCount",
             count(*) FILTER (WHERE ${flag("r", "isIdle")})::int AS "idleCount",
             count(*) FILTER (WHERE ${flag("r", "isUnprotected")})::int AS "unprotectedCount",
             count(*) FILTER (WHERE ${flag("r", "isUnused")})::int AS "unusedCount",
             coalesce(sum((derived->>'estimatedMonthlyCostUsd')::float8)
                      FILTER (WHERE ${flag("r", "isIdle")}), 0)::float8 AS "idleCost"
        FROM ${r} r`,
    ),
  ]);
  // An aggregate always answers one row; the zeros say so to the type checker.
  const counts = flags[0] ?? {
    publicCount: 0,
    adminCount: 0,
    idleCount: 0,
    idleCost: 0,
    unprotectedCount: 0,
    unusedCount: 0,
  };
  return { byKind, byRegion, ...counts };
}

/** The graph, for the frontend to lay out. */
/** The node columns every graph read returns. */
const nodeColumns = sql.raw(`r.arn, r.kind, r.name, r.region,
           (r.derived->>'isPublic')::boolean AS "isPublic",
           (r.derived->>'isAdmin')::boolean AS "isAdmin",
           (r.derived->>'isIdle')::boolean AS "isIdle",
           (r.derived->>'isUnprotected')::boolean AS "isUnprotected",
           (r.derived->>'isUnused')::boolean AS "isUnused",
           (r.derived->>'estimatedMonthlyCostUsd')::float8 AS "estimatedMonthlyCostUsd",
           coalesce(r.derived->>'publicReason', r.derived->>'adminReason',
                    r.derived->>'idleReason', r.derived->>'unprotectedReason',
                    r.derived->>'unusedReason') AS reason`);

/** Findings first, so a capped view of a large group shows what matters. */
const findingsFirst = sql.raw(`coalesce((r.derived->>'isPublic')::boolean, false) DESC,
           coalesce((r.derived->>'isAdmin')::boolean, false) DESC, r.kind, r.name`);

/** Scans whose `graph_group` is known to be filled in. Snapshots never change. */
const grouped = new Set<string>();

/**
 * A scan written before `graph_group` existed gets it on its first read, by
 * the rule the write uses (`db/graphGroup.ts`). A migration could not do
 * this: the snapshot tables force row-level security even on their owner.
 */
async function ensureGroups(scope: GraphScope): Promise<void> {
  if (grouped.has(scope.scanId)) return;
  await withTenant(scope.tenantId, async () => {
    const { rows } = await db.execute(sql`
      SELECT 1 FROM resource_snapshots
       WHERE tenant_id = ${scope.tenantId} AND scan_id = ${scope.scanId}
         AND graph_group IS NULL AND kind NOT IN ('Internet', 'Region', 'Account')
       LIMIT 1`);
    if (rows.length > 0) await db.execute(backfillSql(scope.tenantId, scope.scanId));
  });
  if (grouped.size > 10_000) grouped.clear();
  grouped.add(scope.scanId);
}

/** `IN` lists, so the (scan_id, from_arn) index finds the edges; the view is at most 500 nodes. */
async function edgesAmong(scope: GraphScope, arns: string[]) {
  if (arns.length === 0) return [];
  return read<{ from: string; to: string; type: string; ports: string | null }>(
    scope,
    (_r, e) => sql`
      SELECT from_arn AS "from", to_arn AS "to", rel_type AS type, properties->>'ports' AS ports
        FROM ${e} e
       WHERE from_arn IN ${arns} AND to_arn IN ${arns}
       LIMIT 4000`,
  );
}

export interface GraphView {
  nodes: ResourceRow[];
  edges: { from: string; to: string; type: string; ports: string | null }[];
  /** Every node that matched, of which `nodes` is at most `limit`. */
  total: number;
  truncated: boolean;
}

/**
 * The graph, or one group of it (`vpc:<arn>` or `kind:<Kind>`). Capped, and
 * says so: an account of fifty thousand resources is read a group at a time.
 */
export async function fetchGraph(
  scope: GraphScope,
  params: { region?: string; kinds?: string[]; limit?: number; group?: string } = {},
): Promise<GraphView> {
  const region = params.region ?? null;
  const kinds = params.kinds ? JSON.stringify(params.kinds) : null;
  const group = params.group ?? null;
  const limit = clamp(params.limit, 500);
  if (group !== null) await ensureGroups(scope);
  const nodes = await read<ResourceRow & { total: number }>(
    scope,
    (r, e) => sql`
    SELECT ${nodeColumns}, count(*) OVER ()::int AS total
      FROM ${r} r
     WHERE (${region}::text IS NULL OR r.region = ${region} OR r.region IS NULL)
       AND (${kinds}::jsonb IS NULL OR ${kinds}::jsonb ? r.kind)
       AND (${group}::text IS NULL OR r.graph_group = ${group}
            OR (r.kind = 'Internet' AND EXISTS (
                  SELECT 1 FROM ${e} x JOIN ${r} mm ON mm.arn = x.to_arn
                   WHERE x.from_arn = r.arn AND mm.graph_group = ${group})))
     ORDER BY ${group === null ? sql.raw("r.kind, r.name") : findingsFirst}
     LIMIT ${limit}`,
  );
  const total = nodes[0]?.total ?? 0;
  const rows = nodes.map(({ total: _t, ...n }) => n);
  return {
    nodes: rows,
    edges: await edgesAmong(
      scope,
      rows.map((n) => n.arn),
    ),
    total,
    truncated: total > rows.length,
  };
}

/** The groups a large account is browsed by: each VPC, then each kind outside one. */
export async function graphGroups(scope: GraphScope) {
  await ensureGroups(scope);
  return read<{
    id: string;
    name: string;
    region: string | null;
    count: number;
    publicCount: number;
    adminCount: number;
    kinds: Record<string, number>;
  }>(
    scope,
    (r) => sql`
    WITH per AS (
      SELECT r.graph_group AS "group", r.kind, count(*)::int AS n,
             count(*) FILTER (WHERE (r.derived->>'isPublic')::boolean)::int AS pub,
             count(*) FILTER (WHERE (r.derived->>'isAdmin')::boolean)::int AS adm
        FROM ${r} r
       WHERE r.graph_group IS NOT NULL
       GROUP BY r.graph_group, r.kind
    )
    SELECT per."group" AS id,
           coalesce(v.name, substr(per."group", 6)) AS name,
           v.region,
           sum(per.n)::int AS count,
           sum(per.pub)::int AS "publicCount",
           sum(per.adm)::int AS "adminCount",
           jsonb_object_agg(per.kind, per.n) AS kinds
      FROM per
      LEFT JOIN ${r} v ON per."group" = 'vpc:' || v.arn
     GROUP BY per."group", v.name, v.region
     ORDER BY (per."group" LIKE 'vpc:%') DESC, sum(per.pub) DESC, sum(per.n) DESC`,
  );
}

/** One resource and everything directly joined to it, for expanding a view. */
export async function neighbourhood(
  scope: GraphScope,
  arn: string,
  limit = 60,
): Promise<GraphView> {
  const cap = clamp(limit, 60);
  const nodes = await read<ResourceRow & { total: number }>(
    scope,
    (r, e) => sql`
    WITH near AS (
      SELECT ${arn}::text AS arn
      UNION SELECT to_arn FROM ${e} e WHERE e.from_arn = ${arn} AND e.rel_type <> 'IN_REGION'
      UNION SELECT from_arn FROM ${e} e WHERE e.to_arn = ${arn} AND e.rel_type <> 'IN_REGION'
    )
    SELECT ${nodeColumns}, count(*) OVER ()::int AS total
      FROM ${r} r JOIN near ON near.arn = r.arn
     ORDER BY (r.arn = ${arn}) DESC, ${findingsFirst}
     LIMIT ${cap}`,
  );
  const total = nodes[0]?.total ?? 0;
  const rows = nodes.map(({ total: _t, ...n }) => n);
  return {
    nodes: rows,
    edges: await edgesAmong(
      scope,
      rows.map((n) => n.arn),
    ),
    total,
    truncated: total > rows.length,
  };
}

// --- Paths ------------------------------------------------------------------

interface Hop {
  via: string | null;
  reason: string | null;
  ports: string[];
}

/**
 * Recently walked scans' indexes. A scan's snapshot never changes once
 * written, so an index built for it stays right until the scan is deleted -
 * and loading one is most of a path query's cost on a large account (about two
 * seconds at 50,000 resources), paid again by every follow-up question the
 * agent asks about the same graph. Keyed by tenant as well as scan so that the
 * cache can never answer one tenant with another's edges, and small, because
 * the scans worth caching are the few that people are looking at right now.
 */
const REACH_CACHE_SIZE = 8;
const reachCache = new Map<string, Promise<ReachIndex>>();

function reachIndex(scope: GraphScope): Promise<ReachIndex> {
  const key = `${scope.tenantId}/${scope.scanId}`;
  let index = reachCache.get(key);
  if (index) {
    // Re-inserted to mark it most recently used; Map keeps insertion order.
    reachCache.delete(key);
  } else {
    index = loadReachIndex(scope);
    // A failed load must not be remembered as the answer.
    index.catch(() => reachCache.delete(key));
  }
  reachCache.set(key, index);
  while (reachCache.size > REACH_CACHE_SIZE) {
    reachCache.delete(reachCache.keys().next().value!);
  }
  return index;
}

/**
 * This scan's reach edges and the memberships they expand through: every
 * group's, and the subnets' that are themselves the source of an edge - not
 * every IN_SUBNET row, which is most of the resources in an estate.
 */
async function loadReachIndex(scope: GraphScope): Promise<ReachIndex> {
  const rows = await read<{
    from_arn: string;
    to_arn: string;
    rel_type: string;
    properties: Record<string, unknown>;
  }>(
    scope,
    (_r, e) => sql`SELECT from_arn, to_arn, rel_type, properties FROM ${e} e
                    WHERE rel_type IN ('CAN_REACH', 'HAS_SECURITY_GROUP')
                       OR (rel_type = 'IN_SUBNET' AND to_arn IN (
                             SELECT from_arn FROM ${e} s
                              WHERE rel_type = 'CAN_REACH' AND from_arn LIKE '%:subnet/%'))`,
  );
  return indexReach(
    rows.map((row) => ({
      from: row.from_arn,
      to: row.to_arn,
      type: row.rel_type as Relationship["type"],
      properties: row.properties,
    })),
  );
}

/** One route opened on several ports is one route: merge the rule edges. */
function hopOf(edges: Relationship[]): Hop {
  const ports: string[] = [];
  for (const edge of edges) {
    const value = edge.properties?.["ports"];
    for (const p of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      const text = String(p);
      if (!ports.includes(text)) ports.push(text);
    }
  }
  const first = edges[0]?.properties ?? {};
  return {
    via: (first["via"] as string | undefined) ?? null,
    reason: (first["reason"] as string | undefined) ?? null,
    ports,
  };
}

/** Resolve an ARN or a name to an ARN in this scan, preferring an exact ARN. */
async function resolve(scope: GraphScope, arnOrName: string): Promise<string | null> {
  const [row] = await read<{ arn: string }>(
    scope,
    (r) => sql`
    SELECT arn FROM ${r} r WHERE arn = ${arnOrName} OR name = ${arnOrName}
     ORDER BY (arn = ${arnOrName}) DESC LIMIT 1`,
  );
  return row?.arn ?? null;
}

async function describeNodes(scope: GraphScope, arns: string[]) {
  if (arns.length === 0)
    return new Map<string, { arn: string; name: string; kind: string; region: string | null }>();
  // `IN` (drizzle spreads the array into a parameter list) rather than a JSON
  // containment test: it can use the snapshot's (scan_id, arn) key, where
  // `jsonb ? arn` read every row of the scan. Callers pass a page, not a scan.
  const rows = await read<{ arn: string; name: string; kind: string; region: string | null }>(
    scope,
    (r) => sql`SELECT arn, name, kind, region FROM ${r} r WHERE r.arn IN ${arns}`,
  );
  return new Map(rows.map((row) => [row.arn, row]));
}

/** Paths enumerated before sorting; bounds the work on a dense graph. */
const MAX_PATHS_EXPLORED = 2000;
/** And the time it may take, which a dense graph can spend without finding many. */
const PATH_SEARCH_MS = 2000;

/**
 * Every path by which one resource can be reached from another, shortest
 * first. The default source is the internet, which is what "what can reach
 * X?" almost always means. `stopped` says when the bound was reached, so an
 * answer built on it can say the list is not exhaustive.
 */
export async function networkPaths(
  scope: GraphScope,
  params: { target: string; source?: string; maxHops?: number; limit?: number },
) {
  const maxHops = Math.min(Math.max(1, params.maxHops ?? 5), 8);
  const limit = clamp(params.limit, 25);
  const [target, source] = await Promise.all([
    resolve(scope, params.target),
    resolve(scope, params.source ?? INTERNET_ARN),
  ]);
  if (!target || !source) return { paths: [], found: 0, stopped: null as PathSearchStop };
  const index = await reachIndex(scope);

  const search = searchPaths(index, source, target, maxHops, {
    maxPaths: MAX_PATHS_EXPLORED,
    budgetMs: PATH_SEARCH_MS,
  });
  const found = search.found.map(({ path, edges }) => ({ path, hops: edges.map(hopOf) }));
  const stopped = search.stopped;

  found.sort((a, b) => a.path.length - b.path.length);
  const chosen = found.slice(0, limit);
  const nodes = await describeNodes(scope, [...new Set(chosen.flatMap((c) => c.path))]);
  const paths = chosen.map(({ path, hops }) => ({
    hops: path.map((arn) => {
      const n = nodes.get(arn);
      return { arn, name: n?.name ?? arn, kind: n?.kind ?? "Unknown" };
    }),
    edges: hops,
    length: path.length - 1,
  }));
  return { paths, found: found.length, stopped };
}

export const findNetworkPaths = async (
  scope: GraphScope,
  params: Parameters<typeof networkPaths>[1],
) => (await networkPaths(scope, params)).paths;

/**
 * What a resource can reach, rather than what can reach it. The source comes
 * back too, at `hops: 0`, so an answer that names it can cite it. `total`
 * counts every target, of which `rows` holds the nearest.
 */
export async function reachableFrom(
  scope: GraphScope,
  params: { source: string; maxHops?: number; limit?: number },
) {
  const maxHops = Math.min(Math.max(1, params.maxHops ?? 3), 8);
  const sourceArn = await resolve(scope, params.source);
  if (!sourceArn) return { rows: [], total: 0 };
  const hops = hopsFrom(await reachIndex(scope), sourceArn, maxHops);

  // Nearest first, ties by ARN, cut before anything is looked up: a host on
  // a flat network reaches tens of thousands of resources, and naming all of
  // them to return 25 was most of this query's time.
  const ordered = [...hops]
    .filter(([arn]) => arn !== sourceArn)
    .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const shown: [string, number][] = [[sourceArn, 0], ...ordered.slice(0, clamp(params.limit))];
  const nodes = await describeNodes(
    scope,
    shown.map(([arn]) => arn),
  );
  const rows = shown.map(([arn, h]) => {
    const n = nodes.get(arn);
    return {
      arn,
      kind: n?.kind ?? "Unknown",
      name: n?.name ?? arn,
      region: n?.region ?? null,
      hops: h,
    };
  });
  return { rows, total: ordered.length };
}

export const findReachableFrom = async (
  scope: GraphScope,
  params: Parameters<typeof reachableFrom>[1],
) => (await reachableFrom(scope, params)).rows;
