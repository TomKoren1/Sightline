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

import { sql, type SQL } from "drizzle-orm";
import { INTERNET_ARN, type Relationship, type Resource } from "@sightline/shared";

import { clamp, flag, read, type GraphScope, type ResourceRow } from "./graphRead.js";
import { withTenant } from "./postgres.js";
import { withDocuments } from "./repository.js";
import { hopsFrom, indexReach, type ReachIndex } from "../scan/analysers/reachIndex.js";

export type { GraphScope, ResourceRow } from "./graphRead.js";
export {
  findAdminPrincipals,
  findCrossAccountAccess,
  findIdleResources,
  findInstancesInPublicSubnets,
  findOpenSecurityGroups,
  findPublicResources,
  findUnprotectedBuckets,
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
    }>(
      scope,
      (r) => sql`
      SELECT count(*) FILTER (WHERE ${flag("r", "isPublic")})::int AS "publicCount",
             count(*) FILTER (WHERE ${flag("r", "isAdmin")})::int AS "adminCount",
             count(*) FILTER (WHERE ${flag("r", "isIdle")})::int AS "idleCount",
             count(*) FILTER (WHERE ${flag("r", "isUnprotected")})::int AS "unprotectedCount",
             coalesce(sum((derived->>'estimatedMonthlyCostUsd')::float8)
                      FILTER (WHERE ${flag("r", "isIdle")}), 0)::float8 AS "idleCost"
        FROM ${r} r`,
    ),
  ]);
  return { byKind, byRegion, ...(flags[0] ?? {}) };
}

/** The graph, for the frontend to lay out. */
/** The node columns every graph read returns. */
const nodeColumns = sql.raw(`r.arn, r.kind, r.name, r.region,
           (r.derived->>'isPublic')::boolean AS "isPublic",
           (r.derived->>'isAdmin')::boolean AS "isAdmin",
           (r.derived->>'isIdle')::boolean AS "isIdle",
           (r.derived->>'isUnprotected')::boolean AS "isUnprotected",
           (r.derived->>'estimatedMonthlyCostUsd')::float8 AS "estimatedMonthlyCostUsd",
           coalesce(r.derived->>'publicReason', r.derived->>'adminReason',
                    r.derived->>'idleReason', r.derived->>'unprotectedReason') AS reason`);

/** Findings first, so a capped view of a large group shows what matters. */
const findingsFirst = sql.raw(`coalesce((r.derived->>'isPublic')::boolean, false) DESC,
           coalesce((r.derived->>'isAdmin')::boolean, false) DESC, r.kind, r.name`);

/**
 * Which VPC each resource is in: directly (IN_VPC), through its subnet, or -
 * for a VPC - itself. Everything else is grouped by kind.
 */
const membership = (r: SQL, e: SQL) => sql`
  SELECT DISTINCT ON (r.arn) r.arn,
         CASE WHEN coalesce(v.to_arn, sv.to_arn, CASE WHEN r.kind = 'Vpc' THEN r.arn END) IS NOT NULL
              THEN 'vpc:' || coalesce(v.to_arn, sv.to_arn, r.arn)
              ELSE 'kind:' || r.kind END AS "group"
    FROM ${r} r
    LEFT JOIN ${e} v ON v.from_arn = r.arn AND v.rel_type = 'IN_VPC'
    LEFT JOIN ${e} s ON s.from_arn = r.arn AND s.rel_type = 'IN_SUBNET'
    LEFT JOIN ${e} sv ON sv.from_arn = s.to_arn AND sv.rel_type = 'IN_VPC'
   WHERE r.kind NOT IN ('Internet', 'Region', 'Account')
   ORDER BY r.arn`;

async function edgesAmong(scope: GraphScope, arns: string[]) {
  const list = JSON.stringify(arns);
  return read<{ from: string; to: string; type: string; ports: string | null }>(
    scope,
    (_r, e) => sql`
      SELECT from_arn AS "from", to_arn AS "to", rel_type AS type, properties->>'ports' AS ports
        FROM ${e} e
       WHERE ${list}::jsonb ? from_arn AND ${list}::jsonb ? to_arn
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
  const nodes = await read<ResourceRow & { total: number }>(
    scope,
    (r, e) => sql`
    WITH m AS (${membership(r, e)})
    SELECT ${nodeColumns}, count(*) OVER ()::int AS total
      FROM ${r} r
      LEFT JOIN m ON m.arn = r.arn
     WHERE (${region}::text IS NULL OR r.region = ${region} OR r.region IS NULL)
       AND (${kinds}::jsonb IS NULL OR ${kinds}::jsonb ? r.kind)
       AND (${group}::text IS NULL OR m."group" = ${group}
            OR (r.kind = 'Internet' AND EXISTS (
                  SELECT 1 FROM ${e} x JOIN m mm ON mm.arn = x.to_arn
                   WHERE x.from_arn = r.arn AND mm."group" = ${group})))
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
    (r, e) => sql`
    WITH m AS (${membership(r, e)}),
    per AS (
      SELECT m."group", r.kind, count(*)::int AS n,
             count(*) FILTER (WHERE (r.derived->>'isPublic')::boolean)::int AS pub,
             count(*) FILTER (WHERE (r.derived->>'isAdmin')::boolean)::int AS adm
        FROM m JOIN ${r} r ON r.arn = m.arn
       GROUP BY m."group", r.kind
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
  const list = JSON.stringify(arns);
  const rows = await read<{ arn: string; name: string; kind: string; region: string | null }>(
    scope,
    (r) => sql`SELECT arn, name, kind, region FROM ${r} r WHERE ${list}::jsonb ? arn`,
  );
  return new Map(rows.map((row) => [row.arn, row]));
}

/** Paths enumerated before sorting; bounds the work on a dense graph. */
const MAX_PATHS_EXPLORED = 2000;

/**
 * Every path by which one resource can be reached from another, shortest
 * first. The default source is the internet, which is what "what can reach
 * X?" almost always means.
 */
export async function findNetworkPaths(
  scope: GraphScope,
  params: { target: string; source?: string; maxHops?: number; limit?: number },
) {
  const maxHops = Math.min(Math.max(1, params.maxHops ?? 5), 8);
  const limit = clamp(params.limit, 25);
  const [target, source] = await Promise.all([
    resolve(scope, params.target),
    resolve(scope, params.source ?? INTERNET_ARN),
  ]);
  if (!target || !source) return [];
  const index = await reachIndex(scope);

  // Hops from each node to the target, so the search never follows an edge
  // that cannot arrive within the bound.
  const toTarget = new Map<string, number>([[target, 0]]);
  for (let frontier = [target], d = 1; frontier.length > 0 && d <= maxHops; d++) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const prev of index.prev(node)) {
        if (!toTarget.has(prev)) {
          toTarget.set(prev, d);
          next.push(prev);
        }
      }
    }
    frontier = next;
  }

  const found: { path: string[]; hops: Hop[] }[] = [];
  const walk = (path: string[], hops: Hop[]) => {
    if (found.length >= MAX_PATHS_EXPLORED) return;
    const here = path[path.length - 1]!;
    if (here === target && path.length > 1) {
      found.push({ path: [...path], hops: [...hops] });
      return;
    }
    for (const { to, edges } of index.next(here)) {
      const remaining = toTarget.get(to);
      if (remaining === undefined || path.length + remaining > maxHops + 1) continue;
      if (path.includes(to)) continue;
      path.push(to);
      hops.push(hopOf(edges));
      walk(path, hops);
      path.pop();
      hops.pop();
    }
  };
  if (toTarget.has(source)) walk([source], []);

  found.sort((a, b) => a.path.length - b.path.length);
  const chosen = found.slice(0, limit);
  const nodes = await describeNodes(scope, [...new Set(chosen.flatMap((c) => c.path))]);
  return chosen.map(({ path, hops }) => ({
    hops: path.map((arn) => {
      const n = nodes.get(arn);
      return { arn, name: n?.name ?? arn, kind: n?.kind ?? "Unknown" };
    }),
    edges: hops,
    length: path.length - 1,
  }));
}

/**
 * What a resource can reach, rather than what can reach it. The source comes
 * back too, at `hops: 0`, so an answer that names it can cite it.
 */
export async function findReachableFrom(
  scope: GraphScope,
  params: { source: string; maxHops?: number; limit?: number },
) {
  const maxHops = Math.min(Math.max(1, params.maxHops ?? 3), 8);
  const sourceArn = await resolve(scope, params.source);
  if (!sourceArn) return [];
  const hops = hopsFrom(await reachIndex(scope), sourceArn, maxHops);

  const nodes = await describeNodes(scope, [...hops.keys()]);
  const rows = [...hops]
    .map(([arn, h]) => {
      const n = nodes.get(arn);
      return {
        arn,
        kind: n?.kind ?? "Unknown",
        name: n?.name ?? arn,
        region: n?.region ?? null,
        hops: h,
      };
    })
    .sort((a, b) => a.hops - b.hops || a.name.localeCompare(b.name));
  const [source, ...targets] = rows;
  return [source!, ...targets.slice(0, clamp(params.limit))];
}
