/**
 * Tenant isolation in the graph.
 *
 * Neo4j Community has exactly one database, so isolation here is logical and
 * therefore has to be *proven* rather than asserted (ADR-017). Three guards,
 * in increasing order of how much they actually establish:
 *
 *   1. **Static** - every curated query binds `$tenantId`. Catches a query
 *      written without the predicate.
 *   2. **Runtime** - `readQuery` refuses an unscoped query. Catches a query
 *      assembled at runtime, and needs no database.
 *   3. **Behavioural** - seed two tenants, run every curated query as one,
 *      assert nothing belonging to the other comes back. Catches a query that
 *      binds the parameter and still leaks, which neither of the others can.
 *
 * The first two are lexical and cheap; the third is the one that would have
 * caught the bug that motivated all of this - node identity being `arn` alone,
 * which let one tenant's relationships attach to another tenant's nodes.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { Relationship, Resource } from "@daveio/shared";

import * as q from "../db/queries.js";
import { closeDriver, projectGraph, readQuery } from "../db/neo4j.js";
import type { TenantId } from "./tenant.js";

const HAS_INFRA = !process.env["SKIP_INTEGRATION"];

/** Two tenants that exist only for this test. */
const A = "aaaaaaaa-0000-4000-8000-000000000001" as TenantId;
const B = "bbbbbbbb-0000-4000-8000-000000000002" as TenantId;

// ---------------------------------------------------------------------------
// 1. Static
// ---------------------------------------------------------------------------

describe("every curated query is written tenant-scoped", () => {
  const source = readFileSync(fileURLToPath(new URL("../db/queries.ts", import.meta.url)), "utf8");

  /** Each template literal that looks like Cypher. */
  const cypherBlocks = [...source.matchAll(/`([^`]*MATCH[^`]*)`/g)].map((m) => m[1]!);

  it("finds queries to check at all", () => {
    expect(cypherBlocks.length).toBeGreaterThan(10);
  });

  it.each(cypherBlocks.map((c, i) => [i, c] as const))("query %i binds $tenantId", (_i, cypher) => {
    expect(cypher, `unscoped query:\n${cypher.slice(0, 200)}`).toContain("$tenantId");
  });

  /**
   * The predicate has to be on an anchor, not merely mentioned. A query whose
   * only use of the parameter is in a RETURN would pass the check above and
   * read every tenant's rows.
   */
  it.each(cypherBlocks.map((c, i) => [i, c] as const))(
    "query %i applies $tenantId to a pattern, not just mentions it",
    (_i, cypher) => {
      expect(cypher).toMatch(/\{\s*tenantId:\s*\$tenantId/);
    },
  );
});

// ---------------------------------------------------------------------------
// 2. Runtime - no database needed, because the refusal happens before connecting
// ---------------------------------------------------------------------------

describe("readQuery refuses what it cannot scope", () => {
  it("refuses a query with no tenant at all", async () => {
    await expect(readQuery("MATCH (r:Resource {tenantId: $tenantId}) RETURN r")).rejects.toThrow(
      /no tenant was supplied/i,
    );
  });

  it("refuses a query that does not bind $tenantId", async () => {
    await expect(readQuery("MATCH (r:Resource) RETURN r", {}, A)).rejects.toThrow(
      /does not bind \$tenantId/i,
    );
  });

  it("names the offending query, so the fix is obvious", async () => {
    await expect(readQuery("MATCH (x:Thing) RETURN x", {}, A)).rejects.toThrow(/MATCH \(x:Thing\)/);
  });
});

// ---------------------------------------------------------------------------
// 3. Behavioural
// ---------------------------------------------------------------------------

function resource(tenantLabel: string, arn: string, extra: Partial<Resource> = {}): Resource {
  return {
    arn,
    kind: "S3Bucket",
    name: `${tenantLabel}-bucket`,
    region: "us-east-1",
    accountId: "123456789012",
    tags: {},
    properties: {},
    derived: { isPublic: true, publicReason: `${tenantLabel} reason` },
    ...extra,
  } as Resource;
}

describe.runIf(HAS_INFRA)("two tenants in one graph", () => {
  afterAll(async () => {
    // Leave the database as found: each projection replaces only its own
    // tenant, so projecting nothing is how a tenant is removed.
    await projectGraph(A, "cleanup-a", [], []);
    await projectGraph(B, "cleanup-b", [], []);
    await closeDriver();
  });

  it("keeps resources apart even when they share an ARN", async () => {
    /**
     * The same ARN in both tenants is not a contrived case: it is what happens
     * the moment two customers connect the same AWS account, and it happens
     * immediately for the synthetic `Internet` node, whose ARN is a constant.
     */
    const shared = "arn:aws:s3:::shared-name";
    await projectGraph(A, "scan-a", [resource("alpha", shared)], []);
    await projectGraph(B, "scan-b", [resource("beta", shared)], []);

    const fromA = await q.getResource(A, shared);
    const fromB = await q.getResource(B, shared);

    expect(fromA?.name).toBe("alpha-bucket");
    expect(fromB?.name).toBe("beta-bucket");
  });

  it("does not return the other tenant's resources from any curated query", async () => {
    await projectGraph(A, "scan-a", [resource("alpha", "arn:aws:s3:::alpha-only")], []);
    await projectGraph(B, "scan-b", [resource("beta", "arn:aws:s3:::beta-only")], []);

    const results = await Promise.all([
      q.listResources(A, { limit: 100 }),
      q.findPublicResources(A, { limit: 100 }),
      q.findUnprotectedBuckets(A, { limit: 100 }),
      q.findIdleResources(A, { limit: 100 }),
      q.findAdminPrincipals(A, { limit: 100 }),
      q.findInstancesInPublicSubnets(A, { limit: 100 }),
      q.findOpenSecurityGroups(A, { limit: 100 }),
      q.searchResources(A, { text: "bucket" }),
    ]);

    const names = results.flat().map((r) => (r as { name?: string }).name ?? "");
    expect(names.length).toBeGreaterThan(0);
    expect(names.some((n) => n.startsWith("beta"))).toBe(false);
  });

  it("counts only its own tenant in the account summary", async () => {
    await projectGraph(
      A,
      "scan-a",
      [resource("alpha", "arn:aws:s3:::a1"), resource("alpha", "arn:aws:s3:::a2")],
      [],
    );
    await projectGraph(
      B,
      "scan-b",
      [
        resource("beta", "arn:aws:s3:::b1"),
        resource("beta", "arn:aws:s3:::b2"),
        resource("beta", "arn:aws:s3:::b3"),
      ],
      [],
    );

    const summary = await q.summariseAccount(A);
    const total = summary.byKind.reduce((sum, k) => sum + Number(k.count), 0);
    expect(total).toBe(2);
  });

  /**
   * The edge case that made node identity composite. With uniqueness on `arn`
   * alone, the projection's `MATCH (a {arn: row.from})` would attach this
   * tenant's relationship to whichever tenant owned the node first.
   */
  it("never creates a relationship that crosses tenants", async () => {
    const from = "arn:aws:s3:::shared-from";
    const to = "arn:aws:s3:::shared-to";
    const edge: Relationship = { from, to, type: "IN_REGION" };

    await projectGraph(A, "scan-a", [resource("alpha", from), resource("alpha", to)], [edge]);
    await projectGraph(B, "scan-b", [resource("beta", from), resource("beta", to)], [edge]);

    const crossing = await readQuery<{ count: number }>(
      `MATCH (a:Resource {tenantId: $tenantId})-[r]->(b:Resource)
       WHERE b.tenantId <> $tenantId
       RETURN count(r) AS count`,
      {},
      A,
    );
    expect(Number(crossing[0]?.count ?? 0)).toBe(0);
  });
});
