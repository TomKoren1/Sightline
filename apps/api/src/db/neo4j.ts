/**
 * The Neo4j projection: derived, not authoritative. Replayed from one scan's
 * Postgres snapshots, so a lost or corrupted graph is rebuilt rather than
 * recovered.
 *
 * Every node carries `:Resource`, which the uniqueness constraint hangs off,
 * plus its kind (`:Ec2Instance`) - so a query can be generic or specific
 * without two sets of queries. Labels cannot be parameterised in Cypher, so
 * writes are grouped by kind and the label interpolated - safely, since it
 * comes from a closed enum.
 *
 * **Node identity is `(scanId, arn)`, not `arn`.** An ARN is unique within an
 * AWS account, not across this database. Two tenants collide immediately on
 * the synthetic `Internet` node, whose ARN is a constant for everyone, and
 * completely if they connect the same AWS account. Under a plain constraint on
 * `arn` the edge projection below - which matches endpoints by ARN - would
 * attach one tenant's relationships to another tenant's nodes. That is not a
 * query bug a filter could fix later: the edge would genuinely exist, and
 * every path query would traverse it.
 *
 * **Write-then-flip.** A scan projects into its own scope while the previous
 * graph stays readable, and `scan_runs.projected_at` is what makes the new one
 * current. Nothing is deleted first, so there is no window in which a reader
 * sees a half-built graph, a failed projection costs nothing, and the writes
 * can be committed in batches instead of held in one transaction whose size
 * grows with the customer's estate.
 */

import neo4j, { type Driver, type Session } from "neo4j-driver";
import {
  RELATIONSHIP_TYPES,
  RESOURCE_KINDS,
  type Relationship,
  type Resource,
} from "@sightline/shared";

import { cfg } from "../config.js";
import type { ScanId, TenantId } from "../tenancy/ids.js";

/**
 * Which graph a read may touch.
 *
 * Both halves are bound into every query. The scan id is what isolates - it is
 * half of node identity - and the tenant id is the second lock: a scan id that
 * arrives from a stale page or a bug then returns nothing rather than another
 * tenant's inventory.
 */
export interface GraphScope {
  tenantId: TenantId;
  scanId: ScanId;
}

/** Nodes per write transaction. Bounds heap regardless of account size. */
const PROJECTION_BATCH = 2000;

let driver: Driver | null = null;

export function getDriver(): Driver {
  driver ??= neo4j.driver(cfg.NEO4J_URI, neo4j.auth.basic(cfg.NEO4J_USER, cfg.NEO4J_PASSWORD), {
    maxConnectionPoolSize: 20,
    disableLosslessIntegers: true,
  });
  return driver;
}

export async function closeDriver(): Promise<void> {
  await driver?.close();
  driver = null;
}

/**
 * Is the database reachable?
 *
 * Separate from `readScoped` because it is a liveness probe, not a question
 * about anyone's data - and the alternative, letting the health check pass a
 * scope, would mean inventing one. A route that has to invent a tenant is a
 * route that will one day invent the wrong tenant.
 */
export async function probeNeo4j(): Promise<void> {
  const session = getDriver().session({ defaultAccessMode: neo4j.session.READ });
  try {
    await session.run("RETURN 1 AS ok");
  } finally {
    await session.close();
  }
}

/**
 * Run a scoped read that must not modify anything.
 *
 * The one place tenant scoping can be enforced rather than remembered. A query
 * that does not bind both parameters is **refused**, not silently corrected: a
 * query written without them is a query whose author did not think about
 * tenancy, and appending a predicate would hide that until the day the
 * correction is missing.
 *
 * `executeRead` is not merely advisory either: Neo4j routes it as a read
 * transaction and a write inside one fails. That is the outermost guard behind
 * the agent's Cypher escape hatch, and the reason a validator alone is not
 * relied upon.
 *
 * Note for production: Neo4j **Community has no role-based access control**,
 * so a genuinely read-only database *user* is not available. On Enterprise this
 * would additionally run as a user granted only `MATCH`.
 */
export async function readScoped<T = Record<string, unknown>>(
  scope: GraphScope,
  cypher: string,
  params: Record<string, unknown> = {},
): Promise<T[]> {
  for (const required of ["$tenantId", "$scanId"] as const) {
    if (!cypher.includes(required)) {
      throw new Error(
        `Refusing to run a graph query that does not bind ${required}. Every read is scoped ` +
          "to one tenant's one scan; see the module comment in db/neo4j.ts.",
      );
    }
  }

  const session: Session = getDriver().session({ defaultAccessMode: neo4j.session.READ });
  try {
    const result = await session.executeRead((tx) =>
      tx.run(cypher, { ...params, tenantId: scope.tenantId, scanId: scope.scanId }),
    );
    return result.records.map((record) => record.toObject() as T);
  } finally {
    await session.close();
  }
}

export async function ensureConstraints(): Promise<void> {
  const session = getDriver().session();
  try {
    await session.run(
      `CREATE CONSTRAINT resource_identity IF NOT EXISTS
       FOR (r:Resource) REQUIRE (r.scanId, r.arn) IS UNIQUE`,
    );
    // The single-tenant constraint this replaces. Dropped rather than left
    // behind, because it rejects a second scan holding the same ARN - which is
    // every rescan, not merely a second tenant.
    await session.run(`DROP CONSTRAINT resource_arn IF EXISTS`);
    await session.run(
      `CREATE INDEX resource_scope_kind IF NOT EXISTS
       FOR (r:Resource) ON (r.tenantId, r.scanId, r.kind)`,
    );
    await session.run(
      `CREATE INDEX resource_scope_name IF NOT EXISTS
       FOR (r:Resource) ON (r.tenantId, r.scanId, r.name)`,
    );
    await dropPreTenancyNodes(session);
  } finally {
    await session.close();
  }
}

/**
 * Delete nodes projected before nodes carried a tenant.
 *
 * They are unreachable by every scoped query, which is safe, and unreachable by
 * `sweepSupersededScans` too, which is not: that matches on `tenantId`, so a
 * node without one is never swept and the old graph stays forever. Found by
 * upgrading a database that had been scanned before, where the previous
 * projection's 101 nodes simply stayed.
 *
 * Deleting rather than backfilling a tenant onto them: the graph is a
 * projection, so the cost is one rescan, and guessing which tenant an
 * unlabelled node belonged to is exactly the guess this schema exists to
 * prevent.
 */
async function dropPreTenancyNodes(session: Session): Promise<void> {
  // Batched, because this runs against whatever a long-lived installation
  // happens to have accumulated.
  for (;;) {
    const result = await session.run(
      `MATCH (n:Resource) WHERE n.tenantId IS NULL
       WITH n LIMIT 10000
       DETACH DELETE n
       RETURN count(n) AS deleted`,
    );
    const deleted = (result.records[0]?.get("deleted") as number | undefined) ?? 0;
    if (deleted === 0) return;
  }
}

/**
 * Neo4j properties must be primitives or arrays of primitives.
 *
 * Nested objects - a policy document, a list of ingress rules - are stored as
 * JSON strings under the same key. The query layer parses them back when it
 * needs to, and the UI gets them verbatim.
 */
function flattenProperties(scope: GraphScope, resource: Resource): Record<string, unknown> {
  const out: Record<string, unknown> = {
    arn: resource.arn,
    kind: resource.kind,
    name: resource.name,
    region: resource.region,
    accountId: resource.accountId,
    tenantId: scope.tenantId,
    scanId: scope.scanId,
  };

  for (const [key, value] of Object.entries(resource.properties)) {
    out[key] = primitiveOrJson(value);
  }
  // Derived facts are promoted to top-level properties, because they are what
  // the agent's queries filter on and nesting them would make every query
  // reach through a JSON string.
  for (const [key, value] of Object.entries(resource.derived)) {
    out[key] = primitiveOrJson(value);
  }
  out["tagsJson"] = JSON.stringify(resource.tags);
  for (const [key, value] of Object.entries(resource.tags)) {
    out[`tag_${key}`] = value;
  }
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

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    (out.get(k) ?? out.set(k, []).get(k)!).push(item);
  }
  return out;
}

/**
 * Project one scan into its own graph scope.
 *
 * Deliberately does not delete anything. The previous scan's graph is what
 * readers are still using, and it stays current until `markProjected` says
 * otherwise; `sweepSupersededScans` removes it afterwards, off the critical
 * path.
 */
export async function projectGraph(
  scope: GraphScope,
  resources: Resource[],
  relationships: Relationship[],
): Promise<{ nodes: number; edges: number }> {
  await ensureConstraints();
  const session = getDriver().session();

  try {
    for (const [kind, group] of groupBy(resources, (r) => r.kind)) {
      if (!RESOURCE_KINDS.includes(kind as (typeof RESOURCE_KINDS)[number])) {
        throw new Error(`Refusing to project unknown resource kind: ${kind}`);
      }
      for (let i = 0; i < group.length; i += PROJECTION_BATCH) {
        const rows = group.slice(i, i + PROJECTION_BATCH).map((r) => flattenProperties(scope, r));
        await session.executeWrite((tx) =>
          tx.run(`UNWIND $rows AS row CREATE (n:Resource:${kind}) SET n = row`, { rows }),
        );
      }
    }

    for (const [type, group] of groupBy(relationships, (r) => r.type)) {
      if (!RELATIONSHIP_TYPES.includes(type as (typeof RELATIONSHIP_TYPES)[number])) {
        throw new Error(`Refusing to project unknown relationship type: ${type}`);
      }
      for (let i = 0; i < group.length; i += PROJECTION_BATCH) {
        const rows = group.slice(i, i + PROJECTION_BATCH).map((rel) => ({
          from: rel.from,
          to: rel.to,
          props: Object.fromEntries(
            Object.entries(rel.properties ?? {}).map(([k, v]) => [k, primitiveOrJson(v)]),
          ),
        }));
        /**
         * Endpoints are matched **within this scan**. Matching on `arn` alone
         * is what would attach this tenant's relationships to another's nodes,
         * and the `scanId` here is the same predicate that makes it impossible.
         *
         * Edges whose endpoints were not collected are skipped rather than
         * creating placeholder nodes: a partial scan should leave a graph with
         * missing edges, not one full of phantom resources.
         */
        await session.executeWrite((tx) =>
          tx.run(
            `UNWIND $rows AS row
             MATCH (a:Resource {scanId: $scanId, arn: row.from})
             MATCH (b:Resource {scanId: $scanId, arn: row.to})
             CREATE (a)-[r:${type}]->(b)
             SET r = row.props`,
            { rows, scanId: scope.scanId },
          ),
        );
      }
    }
  } finally {
    await session.close();
  }

  return countScope(scope);
}

/** What this scope actually holds, for reconciliation against Postgres. */
export async function countScope(scope: GraphScope): Promise<{ nodes: number; edges: number }> {
  const [row] = await readScoped<{ nodes: number; edges: number }>(
    scope,
    `MATCH (n:Resource {tenantId: $tenantId, scanId: $scanId})
     OPTIONAL MATCH (n)-[r]->(:Resource {scanId: $scanId})
     RETURN count(DISTINCT n) AS nodes, count(r) AS edges`,
  );
  return row ?? { nodes: 0, edges: 0 };
}

/**
 * Delete the graphs of named scans.
 *
 * Used when a connection is forgotten: Postgres cascades from the row, and this
 * is the half that does not. Batched for the same reason the sweep is - a
 * `DETACH DELETE` of a large estate is the one operation here whose cost scales
 * with the customer rather than with the change.
 */
export async function dropScanScopes(
  tenantId: TenantId,
  scanIds: string[],
  limit = 50_000,
): Promise<number> {
  if (scanIds.length === 0) return 0;
  const session = getDriver().session();
  let total = 0;
  try {
    for (;;) {
      const result = await session.executeWrite((tx) =>
        tx.run(
          `MATCH (n:Resource {tenantId: $tenantId})
           WHERE n.scanId IN $scanIds
           WITH n LIMIT $limit
           DETACH DELETE n
           RETURN count(n) AS deleted`,
          { tenantId, scanIds, limit: neo4j.int(limit) },
        ),
      );
      const deleted = (result.records[0]?.get("deleted") as number | undefined) ?? 0;
      total += deleted;
      if (deleted === 0) return total;
    }
  } finally {
    await session.close();
  }
}

/**
 * Delete everything this tenant has in the graph.
 *
 * For a purge, and deliberately **not** expressed as "drop these scan ids".
 * `dropScanScopes` takes a list, which is right when forgetting one connection
 * because Postgres knows exactly which scans it had. A purge cannot rely on
 * that: a scope whose scan row was already gone - a failed projection, an
 * interrupted sweep - would be left behind, and once the tenant row is deleted
 * there is nothing left to find it with. Matching on the tenant alone catches
 * those.
 *
 * Returns the count so the caller can report what it deleted rather than
 * claiming success. Batched, like the others, because a `DETACH DELETE` of a
 * whole estate is the one operation whose cost scales with the customer.
 */
export async function dropTenantGraph(tenantId: TenantId, limit = 50_000): Promise<number> {
  const session = getDriver().session();
  let total = 0;
  try {
    for (;;) {
      const result = await session.executeWrite((tx) =>
        tx.run(
          `MATCH (n:Resource {tenantId: $tenantId})
           WITH n LIMIT $limit
           DETACH DELETE n
           RETURN count(n) AS deleted`,
          { tenantId, limit: neo4j.int(limit) },
        ),
      );
      const deleted = (result.records[0]?.get("deleted") as number | undefined) ?? 0;
      total += deleted;
      if (deleted === 0) return total;
    }
  } finally {
    await session.close();
  }
}

/**
 * Delete the graphs of scans that are no longer current.
 *
 * Batched and off the critical path, because a `DETACH DELETE` of a large
 * estate is the one operation here whose cost scales with the customer rather
 * than with the change. `keepScanIds` is passed in rather than derived, so the
 * caller - which knows what Postgres considers current - decides what survives.
 */
export async function sweepSupersededScans(
  tenantId: TenantId,
  keepScanIds: string[],
  limit = 50_000,
): Promise<number> {
  const session = getDriver().session();
  try {
    const result = await session.executeWrite((tx) =>
      tx.run(
        `MATCH (n:Resource {tenantId: $tenantId})
         WHERE NOT n.scanId IN $keep
         WITH n LIMIT $limit
         DETACH DELETE n
         RETURN count(n) AS deleted`,
        { tenantId, keep: keepScanIds, limit: neo4j.int(limit) },
      ),
    );
    return (result.records[0]?.get("deleted") as number | undefined) ?? 0;
  } finally {
    await session.close();
  }
}
