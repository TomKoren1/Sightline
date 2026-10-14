/**
 * Deleting an account leaves nothing behind, and leaves other accounts alone.
 *
 * Both halves matter and the second is the one a careless implementation gets
 * wrong: a purge written as "delete where tenant_id = ..." across a list of
 * tables is one forgotten table away from keeping somebody's inventory after
 * they asked for it to be gone, and one wrong predicate away from deleting
 * somebody else's.
 *
 * So this seeds **two** tenants with data in every table, purges one, and
 * checks both directions - the emptiness of one and the untouchedness of the
 * other. The table list is taken from the Drizzle schema by reflection rather
 * than written out, so a table added later is covered without anyone
 * remembering to add it here.
 *
 * Requires Postgres and Neo4j; skipped without them.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { getTableColumns, getTableName } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { INTERNET_ARN, type Relationship, type Resource } from "@sightline/shared";

import { dropTenantGraph, getDriver, projectGraph } from "../db/neo4j.js";
import { system } from "../db/postgres.js";
import * as schema from "../db/schema.js";
import { asScanId, asTenantId, type TenantId } from "./ids.js";
import { confirmationMatches, purgeTenant } from "./purge.js";

const HAS_INFRA = !process.env["SKIP_INTEGRATION"];

interface Fixture {
  tenantId: TenantId;
  connectionId: string;
  scanId: string;
  userId: string;
  conversationId: string;
  tag: string;
}

function fixture(tag: string): Fixture {
  return {
    tenantId: asTenantId(randomUUID()),
    connectionId: randomUUID(),
    scanId: randomUUID(),
    userId: randomUUID(),
    conversationId: randomUUID(),
    tag,
  };
}

const doomed = fixture("doomed");
const bystander = fixture("bystander");

let available = false;

/**
 * Every table that carries a `tenant_id`, from the schema itself.
 *
 * Reflection rather than a list, for the reason this test exists: the mistake
 * is forgetting a table, and a list here would be forgotten in exactly the same
 * breath as the purge.
 */
function tenantScopedTables(): PgTable[] {
  // `as PgTable[]` rather than a type predicate: Drizzle's table type is
  // generic over the specific table, so no single predicate type is assignable
  // to all of them, and the honest way to say "some table from the schema" is
  // the base type.
  const tables = Object.values(schema).filter(
    (value) => typeof value === "object" && value !== null && "_" in value,
  ) as PgTable[];
  return tables.filter((table) => "tenantId" in getTableColumns(table));
}

/** Rows a table holds for one tenant, counted as the owner. */
async function rowsFor(table: PgTable, tenantId: TenantId): Promise<number> {
  const name = getTableName(table);
  const { rows } = await system.execute(
    sql`SELECT count(*)::int AS n FROM ${sql.identifier(name)} WHERE tenant_id = ${tenantId}`,
  );
  return Number((rows[0] as { n: number }).n);
}

/**
 * Nodes this tenant has in the graph, counted through the driver directly.
 *
 * Not `readScoped`, which refuses any query that does not bind a scan id - and
 * refusing is the whole point of it. The question here is "is there anything
 * left for this tenant at all", across every scan, which is exactly the shape
 * that function exists to prevent the application from asking.
 */
async function graphNodes(tenantId: TenantId): Promise<number> {
  const session = getDriver().session();
  try {
    const result = await session.executeRead((tx) =>
      tx.run("MATCH (n:Resource {tenantId: $tenantId}) RETURN count(n) AS n", { tenantId }),
    );
    return Number(result.records[0]?.get("n") ?? 0);
  } finally {
    await session.close();
  }
}

/** One tenant's worth of rows in every table, plus a projected graph. */
async function seed(f: Fixture): Promise<void> {
  await system.insert(schema.tenants).values({ id: f.tenantId, name: `purge.test.${f.tag}` });
  await system
    .insert(schema.users)
    .values({ id: f.userId, tenantId: f.tenantId, email: `${f.tag}-${f.userId}@purge.test` });
  await system.insert(schema.identities).values({
    provider: "google",
    subject: `subject-${f.userId}`,
    userId: f.userId,
  });
  await system.insert(schema.sessions).values({
    id: randomUUID(),
    userId: f.userId,
    // bytea, not text: the column holds the raw SHA-256 of the token.
    tokenHash: Buffer.from(randomUUID().replace(/-/g, ""), "hex"),
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  await system.insert(schema.connections).values({
    id: f.connectionId,
    tenantId: f.tenantId,
    kind: "demo",
    label: f.tag,
    externalIdSource: "demo",
  });
  await system.insert(schema.scanRuns).values({
    id: f.scanId,
    tenantId: f.tenantId,
    connectionId: f.connectionId,
    accountId: "123456789012",
    status: "succeeded",
    startedAt: new Date(),
    projectedAt: new Date(),
  });
  await system.insert(schema.scanUnits).values({
    tenantId: f.tenantId,
    scanId: f.scanId,
    service: "s3",
    region: "global",
    status: "succeeded",
  });
  await system.insert(schema.resourceSnapshots).values({
    tenantId: f.tenantId,
    scanId: f.scanId,
    arn: `arn:aws:s3:::${f.tag}-bucket`,
    kind: "S3Bucket",
    name: `${f.tag}-bucket`,
    region: null,
    accountId: "123456789012",
    fingerprint: randomUUID().replace(/-/g, ""),
  });
  await system.insert(schema.relationshipSnapshots).values({
    tenantId: f.tenantId,
    scanId: f.scanId,
    fromArn: INTERNET_ARN,
    toArn: `arn:aws:s3:::${f.tag}-bucket`,
    relType: "CAN_REACH",
  });
  await system.insert(schema.conversations).values({
    id: f.conversationId,
    tenantId: f.tenantId,
    connectionId: f.connectionId,
    accountId: "123456789012",
  });
  await system.insert(schema.messages).values({
    id: randomUUID(),
    tenantId: f.tenantId,
    conversationId: f.conversationId,
    role: "user",
    content: "which buckets are public?",
  });
  await system.insert(schema.scanJobs).values({
    id: randomUUID(),
    tenantId: f.tenantId,
    connectionId: f.connectionId,
    status: "succeeded",
  });
  await system.insert(schema.auditLog).values({
    id: randomUUID(),
    tenantId: f.tenantId,
    action: "connection.created",
    subject: f.connectionId,
  });

  // And a real projection, so the graph half is not simulated.
  const resources: Resource[] = [
    {
      arn: INTERNET_ARN,
      kind: "Internet",
      name: "Public internet",
      region: null,
      accountId: "123456789012",
      tags: {},
      properties: {},
      derived: {},
    },
    {
      arn: `arn:aws:s3:::${f.tag}-bucket`,
      kind: "S3Bucket",
      name: `${f.tag}-bucket`,
      region: null,
      accountId: "123456789012",
      tags: {},
      properties: {},
      derived: { isPublic: true },
    },
  ];
  const relationships: Relationship[] = [
    { from: INTERNET_ARN, to: `arn:aws:s3:::${f.tag}-bucket`, type: "CAN_REACH", properties: {} },
  ];
  await projectGraph(
    { tenantId: f.tenantId, scanId: asScanId(f.scanId) },
    resources,
    relationships,
  );
}

beforeAll(async () => {
  if (!HAS_INFRA) return;
  try {
    await system.execute("SELECT 1");
  } catch {
    return;
  }
  await seed(doomed);
  await seed(bystander);
  available = true;
});

afterAll(async () => {
  if (!available) return;
  // The doomed one is already gone; this is for the bystander and for a run
  // that failed partway.
  for (const f of [doomed, bystander]) {
    await system.delete(schema.tenants).where(eq(schema.tenants.id, f.tenantId));
  }
  for (const f of [doomed, bystander]) await dropTenantGraph(f.tenantId);
});

describe.runIf(HAS_INFRA)("purging a tenant", () => {
  it("has a database, and seeded data in every tenant-scoped table", async () => {
    expect(available, "Postgres is not reachable, so none of this was checked").toBe(true);
    if (!available) return;

    /**
     * The fixture has to populate every table, or the purge is being asserted
     * against emptiness that was already there. This is the assertion that
     * makes the rest mean something, and it fails when a new table is added to
     * the schema and not to `seed` - which is the right moment to notice.
     */
    const empty: string[] = [];
    for (const table of tenantScopedTables()) {
      if ((await rowsFor(table, doomed.tenantId)) === 0) empty.push(getTableName(table));
    }
    expect(
      empty,
      "the fixture seeds nothing into these tables, so the purge is not actually tested against " +
        "them. Add rows for them to `seed`.",
    ).toEqual([]);
    expect(await graphNodes(doomed.tenantId)).toBeGreaterThan(0);
  });

  it("deletes everything, and says what it deleted", async () => {
    if (!available) return;
    const result = await purgeTenant(doomed.tenantId);

    // Reported rather than assumed: a purge that returned 200 and nothing else
    // would be indistinguishable from one that did nothing.
    expect(result.graphNodes).toBeGreaterThan(0);
    expect(result).toMatchObject({
      connections: 1,
      scans: 1,
      conversations: 1,
      messages: 1,
      users: 1,
      sessions: 1,
    });
  });

  it("leaves no row in any tenant-scoped table", async () => {
    if (!available) return;
    const remaining: string[] = [];
    for (const table of tenantScopedTables()) {
      const n = await rowsFor(table, doomed.tenantId);
      if (n > 0) remaining.push(`${getTableName(table)} (${n})`);
    }
    expect(
      remaining,
      "these tables still hold the purged tenant's rows. Every one of them should reference " +
        "tenants.id with ON DELETE CASCADE, directly or through users.",
    ).toEqual([]);
  });

  it("deletes rows with the tenant rather than orphaning them", async () => {
    if (!available) return;

    /**
     * Asked of the catalogue, because counting rows cannot answer it.
     *
     * The first version of this file checked only `WHERE tenant_id = <id>`, and
     * a deliberately broken `ON DELETE SET NULL` on `audit_log` **passed**: the
     * row survived with its `tenant_id` nulled, still carrying the subject and
     * the detail, and a count filtered on the tenant cannot see a row that no
     * longer names one. "Orphaned" and "deleted" look identical from there, and
     * only one of them honours a deletion request.
     *
     * So the referential action itself is the assertion. `a` is CASCADE, `n` is
     * SET NULL, `r` is RESTRICT and `a`... the codes are pg's: 'c' cascade,
     * 'n' set null, 'd' set default, 'r' restrict, 'a' no action.
     */
    const { rows } = await system.execute(sql`
      SELECT c.conname      AS name,
             rel.relname    AS "table",
             c.confdeltype  AS action
        FROM pg_constraint c
        JOIN pg_class rel ON rel.oid = c.conrelid
        JOIN pg_class ref ON ref.oid = c.confrelid
        JOIN pg_namespace n ON n.oid = rel.relnamespace
       WHERE c.contype = 'f'
         AND n.nspname = 'public'
         AND ref.relname = 'tenants'
    `);

    const notCascading = (rows as { name: string; table: string; action: string }[])
      .filter((r) => r.action !== "c")
      .map((r) => `${r.table}.${r.name} (ON DELETE ${r.action})`);

    expect(
      notCascading,
      "these foreign keys to `tenants` do not cascade, so purging a tenant either fails or " +
        "leaves the rows behind with a null tenant_id - still holding their content, and " +
        "invisible to any count scoped to the tenant.",
    ).toEqual([]);

    // And it looked at something, rather than passing on an empty result.
    expect(rows.length).toBeGreaterThan(5);
  });

  it("leaves nothing in the auth tables either", async () => {
    if (!available) return;
    // These carry no `tenant_id`, so the reflective sweep above does not reach
    // them - they cascade through `users`, which is a second hop and therefore
    // a second thing that can be wrong.
    const { rows: identities } = await system.execute(
      sql`SELECT count(*)::int AS n FROM identities WHERE user_id = ${doomed.userId}`,
    );
    const { rows: sessions } = await system.execute(
      sql`SELECT count(*)::int AS n FROM sessions WHERE user_id = ${doomed.userId}`,
    );
    expect(Number((identities[0] as { n: number }).n)).toBe(0);
    expect(Number((sessions[0] as { n: number }).n)).toBe(0);
  });

  it("leaves nothing in the graph", async () => {
    if (!available) return;
    expect(await graphNodes(doomed.tenantId)).toBe(0);
  });

  it("does not touch the other tenant", async () => {
    if (!available) return;
    /**
     * The half a careless purge gets wrong. Every table is checked, not a
     * sample, because "deleted too much" and "deleted too little" are different
     * mistakes and only one of them can be undone.
     */
    const lost: string[] = [];
    for (const table of tenantScopedTables()) {
      if ((await rowsFor(table, bystander.tenantId)) === 0) lost.push(getTableName(table));
    }
    expect(lost, "purging one tenant removed another tenant's rows from these tables").toEqual([]);
    expect(await graphNodes(bystander.tenantId)).toBeGreaterThan(0);
  });
});

describe("the confirmation", () => {
  it("accepts the account's own email, however it was typed", () => {
    // Case and surrounding whitespace are how a pasted address arrives; being
    // strict about them would make a correct answer look wrong.
    expect(confirmationMatches("tom@example.com", "tom@example.com")).toBe(true);
    expect(confirmationMatches("tom@example.com", "  TOM@Example.com  ")).toBe(true);
  });

  it("accepts nothing else", () => {
    for (const wrong of [
      "",
      "   ",
      "DELETE",
      "yes",
      "someone@else.com",
      "tom@example.co",
      undefined,
      null,
      true,
      { confirm: "tom@example.com" },
    ]) {
      expect(confirmationMatches("tom@example.com", wrong), JSON.stringify(wrong)).toBe(false);
    }
  });
});
