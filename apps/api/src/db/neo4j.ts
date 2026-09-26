/**
 * The Neo4j projection.
 *
 * This graph is derived, not authoritative (ADR-003). It is rebuilt wholesale
 * from the Postgres snapshots of a single scan, inside one transaction, so a
 * reader never sees a half-built graph and a failed rebuild leaves the previous
 * one intact.
 *
 * Every node carries two labels: `:Resource`, which everything shares and the
 * uniqueness constraint hangs off, and its kind (`:Ec2Instance`, `:S3Bucket`).
 * That lets a query be generic across the estate or specific to one type
 * without maintaining two sets of queries.
 *
 * Labels and relationship types cannot be parameterised in Cypher, so writes
 * are grouped by kind and the label is interpolated - safely, because it comes
 * from our own closed enum and never from user input.
 */

import neo4j, { type Driver, type Session } from "neo4j-driver";
import {
  RELATIONSHIP_TYPES,
  RESOURCE_KINDS,
  type Relationship,
  type Resource,
} from "@daveio/shared";

import { cfg } from "../config.js";
import type { TenantId } from "../tenancy/tenant.js";

let driver: Driver | null = null;

export function getDriver(): Driver {
  if (!driver) {
    driver = neo4j.driver(cfg.NEO4J_URI, neo4j.auth.basic(cfg.NEO4J_USER, cfg.NEO4J_PASSWORD), {
      maxConnectionPoolSize: 20,
      disableLosslessIntegers: true,
    });
  }
  return driver;
}

export async function closeDriver(): Promise<void> {
  await driver?.close();
  driver = null;
}

/**
 * Run a query that must not modify anything.
 *
 * `executeRead` is not merely advisory: Neo4j routes it as a read transaction
 * and a write inside one fails. This is the outermost guard behind the agent's
 * Cypher escape hatch, and the reason a validator alone is not relied upon.
 *
 * Note for production: Neo4j **Community has no role-based access control**,
 * so a genuinely read-only database *user* is not available here. On
 * Enterprise this would additionally run as a user granted only `MATCH`.
 * See docs/ENGINEERING-LOG.md #7.
 */
/**
 * The tenant seam.
 *
 * Every graph read in this codebase goes through here, which is what makes
 * this the one place tenant scoping can be enforced rather than remembered.
 * A query that does not bind `$tenantId` is **refused**, not silently
 * filtered: a query written without the predicate is a query whose author did
 * not think about tenancy, and running a corrected version of it would hide
 * that until the day the correction is missing (ADR-017).
 *
 * The check is lexical, which is the same shape as `cypherGuard.ts` and has
 * the same honest limitation: it proves the parameter is *mentioned*, not that
 * it is applied to the right pattern. That gap is why the real assurance is
 * the behavioural test - seed two tenants, run every curated query as one,
 * assert nothing belonging to the other comes back - and why this is the
 * cheapest of three guards rather than the only one.
 */
export async function readQuery<T = Record<string, unknown>>(
  cypher: string,
  params: Record<string, unknown> = {},
  tenantId?: TenantId,
): Promise<T[]> {
  const scoped = tenantId ?? (params["tenantId"] as TenantId | undefined);
  if (!scoped) {
    throw new Error(
      "Refusing to run an unscoped graph query: no tenant was supplied. " +
        "Every read must be scoped to one tenant (ADR-017).",
    );
  }
  if (!cypher.includes("$tenantId")) {
    throw new Error(
      "Refusing to run a graph query that does not bind $tenantId. " +
        `Add the predicate to every anchor pattern. Query: ${cypher.slice(0, 120)}`,
    );
  }

  const session: Session = getDriver().session({ defaultAccessMode: neo4j.session.READ });
  try {
    const result = await session.executeRead((tx) =>
      tx.run(cypher, { ...params, tenantId: scoped }),
    );
    return result.records.map((record) => record.toObject() as T);
  } finally {
    await session.close();
  }
}

export async function ensureConstraints(): Promise<void> {
  const session = getDriver().session();
  try {
    /**
     * Identity is **(tenantId, arn)**, not arn.
     *
     * An ARN is unique within an AWS account, not across this database. Two
     * tenants collide immediately on the synthetic nodes - `INTERNET_ARN` is
     * the same string for everyone - and two tenants who connect the *same*
     * AWS account collide on every real resource in it.
     *
     * With a plain uniqueness constraint on `arn`, the edge projection below
     * (`MATCH (a:Resource {arn: row.from})`) would attach one tenant's
     * relationships to another tenant's nodes. Not a query bug that a filter
     * could fix later: the edge would genuinely exist, and every path query
     * would traverse it.
     */
    await session.run(
      `CREATE CONSTRAINT resource_identity IF NOT EXISTS
       FOR (r:Resource) REQUIRE (r.tenantId, r.arn) IS UNIQUE`,
    );
    // The single-tenant constraint this replaces. Dropped rather than left
    // behind, because it would reject a second tenant holding the same ARN.
    await session.run(`DROP CONSTRAINT resource_arn IF EXISTS`);
    await session.run(
      `CREATE INDEX resource_tenant_kind IF NOT EXISTS FOR (r:Resource) ON (r.tenantId, r.kind)`,
    );
    await session.run(
      `CREATE INDEX resource_tenant_name IF NOT EXISTS FOR (r:Resource) ON (r.tenantId, r.name)`,
    );
  } finally {
    await session.close();
  }
}

/**
 * Neo4j properties must be primitives or arrays of primitives.
 *
 * Nested objects - a policy document, a list of ingress rules - are stored as
 * JSON strings under the same key. The query layer parses them back when it
 * needs to, and the UI gets them verbatim.
 */
function flattenProperties(resource: Resource): Record<string, unknown> {
  const out: Record<string, unknown> = {
    arn: resource.arn,
    kind: resource.kind,
    name: resource.name,
    region: resource.region,
    accountId: resource.accountId,
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

/**
 * Replace the graph with the contents of one scan.
 *
 * Wholesale replacement rather than an incremental merge. At this scale it is
 * simpler and leaves no stale nodes behind, which an incremental update has to
 * work hard to guarantee. On an account with hundreds of thousands of
 * resources this becomes the wrong trade - see the README on what breaks
 * first.
 */
export async function projectGraph(
  tenantId: TenantId,
  scanId: string,
  resources: Resource[],
  relationships: Relationship[],
): Promise<{ nodes: number; edges: number }> {
  await ensureConstraints();
  const session = getDriver().session();

  try {
    await session.executeWrite(async (tx) => {
      // The previous projection goes in one statement, so readers see either
      // the old graph or the new one - and **only this tenant's**, which is
      // the difference between rebuilding a projection and wiping the service.
      await tx.run(`MATCH (n:Resource {tenantId: $tenantId}) DETACH DELETE n`, { tenantId });

      const byKind = new Map<string, Resource[]>();
      for (const resource of resources) {
        (byKind.get(resource.kind) ?? byKind.set(resource.kind, []).get(resource.kind)!).push(
          resource,
        );
      }

      for (const [kind, group] of byKind) {
        if (!RESOURCE_KINDS.includes(kind as (typeof RESOURCE_KINDS)[number])) {
          throw new Error(`Refusing to project unknown resource kind: ${kind}`);
        }
        await tx.run(
          `UNWIND $rows AS row
           CREATE (n:Resource:${kind})
           SET n = row, n.scanId = $scanId`,
          { rows: group.map((r) => ({ ...flattenProperties(r), tenantId })), scanId },
        );
      }

      const byType = new Map<string, Relationship[]>();
      for (const rel of relationships) {
        (byType.get(rel.type) ?? byType.set(rel.type, []).get(rel.type)!).push(rel);
      }

      for (const [type, group] of byType) {
        if (!RELATIONSHIP_TYPES.includes(type as (typeof RELATIONSHIP_TYPES)[number])) {
          throw new Error(`Refusing to project unknown relationship type: ${type}`);
        }
        // Edges whose endpoints were not collected are skipped rather than
        // creating placeholder nodes: a partial scan should leave a graph with
        // missing edges, not one full of phantom resources.
        await tx.run(
          `UNWIND $rows AS row
           MATCH (a:Resource {tenantId: $tenantId, arn: row.from})
           MATCH (b:Resource {tenantId: $tenantId, arn: row.to})
           CREATE (a)-[r:${type}]->(b)
           SET r = row.props`,
          {
            tenantId,
            rows: group.map((rel) => ({
              from: rel.from,
              to: rel.to,
              props: Object.fromEntries(
                Object.entries(rel.properties ?? {}).map(([k, v]) => [k, primitiveOrJson(v)]),
              ),
            })),
          },
        );
      }
    });

    const counts = await readQuery<{ nodes: number; edges: number }>(
      `MATCH (n:Resource {tenantId: $tenantId}) WITH count(n) AS nodes
       MATCH (:Resource {tenantId: $tenantId})-[r]->() RETURN nodes, count(r) AS edges`,
      {},
      tenantId,
    );
    return counts[0] ?? { nodes: resources.length, edges: 0 };
  } finally {
    await session.close();
  }
}
