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

import { db, withTenant } from "./postgres.js";
import { hopsFrom, indexReach, type ReachIndex } from "../scan/analysers/reachIndex.js";
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
const clamp = (n: number | undefined, fallback = DEFAULT_LIMIT) => {
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

async function read<T>(scope: GraphScope, query: (r: SQL, e: SQL) => SQL): Promise<T[]> {
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
const flag = (column: string, key: string) => sql.raw(`(${column}.derived->>'${key}')::boolean`);

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

// --- Lookups and filters ----------------------------------------------------

export async function listResources(
  scope: GraphScope,
  params: { kind?: string; region?: string; nameContains?: string; limit?: number },
): Promise<ResourceRow[]> {
  const kind = params.kind ?? null;
  const region = params.region ?? null;
  const name = params.nameContains?.toLowerCase() ?? null;
  return read(
    scope,
    (r) => sql`
    SELECT arn, kind, name, region,
           ${flag("r", "isPublic")} AS "isPublic",
           ${flag("r", "isAdmin")} AS "isAdmin",
           ${flag("r", "isIdle")} AS "isIdle"
      FROM ${r} r
     WHERE kind <> 'Internet'
       AND (${kind}::text IS NULL OR kind = ${kind})
       AND (${region}::text IS NULL OR region = ${region})
       AND (${name}::text IS NULL OR position(${name} in lower(name)) > 0)
     ORDER BY kind, name
     LIMIT ${clamp(params.limit)}`,
  );
}

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
    props: flattenResource({ ...row, accountId: row.account_id }),
    arn: row.arn,
    kind: row.kind,
    name: row.name,
    region: row.region,
    outgoing: side("out"),
    incoming: side("in"),
  };
}

/**
 * Resources an anonymous caller can reach. `isPublic` was decided at ingest by
 * analysers that are unit tested, and `publicReason` records the evidence.
 */
export async function findPublicResources(
  scope: GraphScope,
  params: { kind?: string; limit?: number } = {},
) {
  const kind = params.kind ?? null;
  return read<ResourceRow>(
    scope,
    (r) => sql`
    SELECT arn, kind, name, region, derived->>'publicReason' AS reason
      FROM ${r} r
     WHERE ${flag("r", "isPublic")} AND (${kind}::text IS NULL OR kind = ${kind})
     ORDER BY kind, name
     LIMIT ${clamp(params.limit)}`,
  );
}

/**
 * Principals that are effectively administrators, and what uses them. An admin
 * role on a running instance is an incident; one nothing references is
 * cleanup. A user has nothing to be used by, which is itself the finding.
 */
export async function findAdminPrincipals(scope: GraphScope, params: { limit?: number } = {}) {
  return read<ResourceRow>(
    scope,
    (r, e) => sql`
    WITH admins AS (
      SELECT arn, kind, name, derived FROM ${r} r
       WHERE kind IN ('IamRole', 'IamUser') AND ${flag("r", "isAdmin")}
    ),
    users AS (
      SELECT a.arn AS admin, i.arn, i.name, i.kind
        FROM admins a
        JOIN ${e} pr ON pr.rel_type = 'PROVIDES_ROLE' AND pr.to_arn = a.arn
        JOIN ${e} hp ON hp.rel_type = 'HAS_INSTANCE_PROFILE' AND hp.to_arn = pr.from_arn
        JOIN ${r} i ON i.arn = hp.from_arn AND i.kind = 'Ec2Instance'
      UNION
      SELECT a.arn, f.arn, f.name, f.kind
        FROM admins a
        JOIN ${e} ex ON ex.rel_type = 'EXECUTES_AS' AND ex.to_arn = a.arn
        JOIN ${r} f ON f.arn = ex.from_arn
    )
    SELECT a.arn, a.kind, a.name, NULL AS region,
           a.derived->>'adminReason' AS reason,
           a.derived->>'adminVia' AS "adminVia",
           coalesce(jsonb_agg(jsonb_build_object('arn', u.arn, 'name', u.name, 'kind', u.kind))
                    FILTER (WHERE u.arn IS NOT NULL), '[]'::jsonb) AS "usedBy",
           count(u.arn)::int AS "useCount"
      FROM admins a LEFT JOIN users u ON u.admin = a.arn
     GROUP BY a.arn, a.kind, a.name, a.derived
     ORDER BY "useCount" DESC, a.name
     LIMIT ${clamp(params.limit)}`,
  );
}

/**
 * Instances outside a private subnet: in a subnet that routes to an internet
 * gateway, or in no subnet at all - the rarer half, and easier to miss.
 */
export async function findInstancesInPublicSubnets(
  scope: GraphScope,
  params: { limit?: number } = {},
) {
  return read<ResourceRow>(
    scope,
    (r, e) => sql`
    SELECT i.arn, 'Ec2Instance' AS kind, i.name, i.region,
           i.properties->>'state' AS state,
           coalesce(s.name, '(none)') AS subnet,
           CASE WHEN s.arn IS NULL THEN 'Instance is not associated with any subnet'
                ELSE s.derived->>'publicReason' END AS reason
      FROM ${r} i
      LEFT JOIN ${e} sn ON sn.rel_type = 'IN_SUBNET' AND sn.from_arn = i.arn
      LEFT JOIN ${r} s ON s.arn = sn.to_arn AND s.kind = 'Subnet'
     WHERE i.kind = 'Ec2Instance' AND (s.arn IS NULL OR ${flag("s", "isPublic")})
     ORDER BY i.name
     LIMIT ${clamp(params.limit)}`,
  );
}

/** Billable and doing nothing, most expensive first. */
export async function findIdleResources(scope: GraphScope, params: { limit?: number } = {}) {
  return read<ResourceRow>(
    scope,
    (r) => sql`
    SELECT arn, kind, name, region, derived->>'idleReason' AS reason,
           coalesce((derived->>'estimatedMonthlyCostUsd')::float8, 0) AS "estimatedMonthlyCostUsd"
      FROM ${r} r
     WHERE ${flag("r", "isIdle")}
     ORDER BY "estimatedMonthlyCostUsd" DESC, name
     LIMIT ${clamp(params.limit)}`,
  );
}

/**
 * Buckets nothing would stop from being made public. Not public: Block Public
 * Access being off grants nobody anything. A posture finding, not exposure.
 */
export async function findUnprotectedBuckets(scope: GraphScope, params: { limit?: number } = {}) {
  return read<ResourceRow>(
    scope,
    (r) => sql`
    SELECT arn, 'S3Bucket' AS kind, name, region, derived->>'unprotectedReason' AS reason,
           coalesce(${flag("r", "isPublic")}, false) AS "isPublic"
      FROM ${r} r
     WHERE kind = 'S3Bucket' AND ${flag("r", "isUnprotected")}
     ORDER BY name
     LIMIT ${clamp(params.limit)}`,
  );
}

/** Resources the internet reaches directly, with the rule that lets it. */
export async function findOpenSecurityGroups(scope: GraphScope, params: { limit?: number } = {}) {
  return read<ResourceRow>(
    scope,
    (r, e) => sql`
    SELECT t.arn, t.kind, t.name, t.region,
           array_agg(DISTINCT e.properties->>'ports') AS ports,
           (array_agg(e.properties->>'via' ORDER BY e.properties->>'via'))[1] AS "securityGroup",
           (array_agg(e.properties->>'reason' ORDER BY e.properties->>'via'))[1] AS reason
      FROM ${e} e JOIN ${r} t ON t.arn = e.to_arn
     WHERE e.rel_type = 'CAN_REACH' AND e.from_arn = ${INTERNET_ARN}
     GROUP BY t.arn, t.kind, t.name, t.region
     ORDER BY t.name
     LIMIT ${clamp(params.limit)}`,
  );
}

/** Free-text search across resource names, tags and ARNs. */
export async function searchResources(scope: GraphScope, params: { text: string; limit?: number }) {
  const text = params.text.toLowerCase();
  return read<ResourceRow>(
    scope,
    (r) => sql`
    SELECT arn, kind, name, region
      FROM ${r} r
     WHERE position(${text} in lower(name)) > 0
        OR position(${text} in lower(tags::text)) > 0
        OR position(${text} in lower(arn)) > 0
     ORDER BY kind, name
     LIMIT ${clamp(params.limit, 25)}`,
  );
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
export async function fetchGraph(
  scope: GraphScope,
  params: { region?: string; kinds?: string[]; limit?: number } = {},
) {
  const region = params.region ?? null;
  const kinds = params.kinds ? JSON.stringify(params.kinds) : null;
  const nodes = await read<ResourceRow>(
    scope,
    (r) => sql`
    SELECT arn, kind, name, region,
           ${flag("r", "isPublic")} AS "isPublic",
           ${flag("r", "isAdmin")} AS "isAdmin",
           ${flag("r", "isIdle")} AS "isIdle",
           ${flag("r", "isUnprotected")} AS "isUnprotected",
           (derived->>'estimatedMonthlyCostUsd')::float8 AS "estimatedMonthlyCostUsd",
           coalesce(derived->>'publicReason', derived->>'adminReason',
                    derived->>'idleReason', derived->>'unprotectedReason') AS reason
      FROM ${r} r
     WHERE (${region}::text IS NULL OR region = ${region} OR region IS NULL)
       AND (${kinds}::jsonb IS NULL OR ${kinds}::jsonb ? kind)
     ORDER BY kind, name
     LIMIT ${clamp(params.limit, 500)}`,
  );

  const arns = JSON.stringify(nodes.map((n) => n.arn));
  const edges = await read<{ from: string; to: string; type: string; ports: string | null }>(
    scope,
    (_r, e) => sql`
      SELECT from_arn AS "from", to_arn AS "to", rel_type AS type, properties->>'ports' AS ports
        FROM ${e} e
       WHERE ${arns}::jsonb ? from_arn AND ${arns}::jsonb ? to_arn
       LIMIT 2000`,
  );
  return { nodes, edges };
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

/** This scan's reach edges and group memberships, ready to walk. */
async function loadReachIndex(scope: GraphScope): Promise<ReachIndex> {
  const rows = await read<{
    from_arn: string;
    to_arn: string;
    rel_type: string;
    properties: Record<string, unknown>;
  }>(
    scope,
    (_r, e) => sql`SELECT from_arn, to_arn, rel_type, properties FROM ${e} e
                    WHERE rel_type IN ('CAN_REACH', 'HAS_SECURITY_GROUP')`,
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
