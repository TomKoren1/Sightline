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
export async function readQuery<T = Record<string, unknown>>(
  cypher: string,
  params: Record<string, unknown> = {},
): Promise<T[]> {
  const session: Session = getDriver().session({ defaultAccessMode: neo4j.session.READ });
  try {
    const result = await session.executeRead((tx) => tx.run(cypher, params));
    return result.records.map((record) => record.toObject() as T);
  } finally {
    await session.close();
  }
}

export async function ensureConstraints(): Promise<void> {
  const session = getDriver().session();
  try {
    await session.run(
      `CREATE CONSTRAINT resource_arn IF NOT EXISTS
       FOR (r:Resource) REQUIRE r.arn IS UNIQUE`,
    );
    await session.run(`CREATE INDEX resource_kind IF NOT EXISTS FOR (r:Resource) ON (r.kind)`);
    await session.run(`CREATE INDEX resource_name IF NOT EXISTS FOR (r:Resource) ON (r.name)`);
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
  scanId: string,
  resources: Resource[],
  relationships: Relationship[],
): Promise<{ nodes: number; edges: number }> {
  await ensureConstraints();
  const session = getDriver().session();

  try {
    await session.executeWrite(async (tx) => {
      // The previous projection goes in one statement, so readers see either
      // the old graph or the new one.
      await tx.run(`MATCH (n:Resource) DETACH DELETE n`);

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
          { rows: group.map(flattenProperties), scanId },
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
           MATCH (a:Resource {arn: row.from})
           MATCH (b:Resource {arn: row.to})
           CREATE (a)-[r:${type}]->(b)
           SET r = row.props`,
          {
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
      `MATCH (n:Resource) WITH count(n) AS nodes
       MATCH ()-[r]->() RETURN nodes, count(r) AS edges`,
    );
    return counts[0] ?? { nodes: resources.length, edges: 0 };
  } finally {
    await session.close();
  }
}
