/**
 * Scanning one account must not delete another account's graph.
 *
 * The sweep matches on the **tenant**, so what it keeps has to be every
 * connection's current graph. It was told only about the connection being
 * scanned, so a tenant with two accounts lost the graph of the other one.
 *
 * Silent in the worst way: Postgres still recorded the deleted scan as
 * projected, so switching to that account rendered an **empty graph** rather
 * than an error - indistinguishable from "your account contains nothing".
 *
 * Found on a live deployment: 55 resources projected at 10:17, gone at 10:21
 * when the other account was scanned. Requires Postgres and Neo4j.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Relationship, Resource } from "@sightline/shared";

import { getDriver, projectGraph, sweepSupersededScans } from "../db/neo4j.js";
import { projectedScanIdsToKeep } from "../db/repository.js";
import { system } from "../db/postgres.js";
import * as schema from "../db/schema.js";
import { asScanId, asTenantId } from "../tenancy/ids.js";

const HAS_INFRA = !process.env["SKIP_INTEGRATION"];

const tenantId = asTenantId(randomUUID());
/** Two connections, because one cannot demonstrate anything about the other. */
const accountA = { connectionId: randomUUID(), scanId: asScanId(randomUUID()), tag: "retain-a" };
const accountB = { connectionId: randomUUID(), scanId: asScanId(randomUUID()), tag: "retain-b" };

let available = false;

/** One bucket, named so the two accounts cannot be confused. */
function inventory(tag: string): { resources: Resource[]; relationships: Relationship[] } {
  return {
    resources: [
      {
        arn: `arn:aws:s3:::${tag}`,
        kind: "S3Bucket",
        name: tag,
        region: null,
        accountId: "123456789012",
        derived: {},
        properties: {},
        // `tags` is read by the projection too, and omitting it threw
        // "Cannot convert undefined or null to object" from inside
        // `flattenProperties`. No cast here deliberately: the first draft had
        // one, which is what let an incomplete resource compile.
        tags: {},
      },
    ],
    relationships: [],
  };
}

async function seedConnection(c: { connectionId: string; scanId: string; tag: string }) {
  await system.insert(schema.connections).values({
    id: c.connectionId,
    tenantId,
    kind: "demo",
    label: c.tag,
    externalIdSource: "demo",
  });
  await system.insert(schema.scanRuns).values({
    id: c.scanId,
    tenantId,
    connectionId: c.connectionId,
    accountId: "123456789012",
    status: "succeeded",
    startedAt: new Date(),
    projectedAt: new Date(),
  });
  await projectGraph(
    { tenantId, scanId: asScanId(c.scanId) },
    inventory(c.tag).resources,
    inventory(c.tag).relationships,
  );
}

/** Nodes present for one scan, counted through the driver. */
async function nodesFor(scanId: string): Promise<number> {
  const session = getDriver().session();
  try {
    const result = await session.executeRead((tx) =>
      tx.run("MATCH (n:Resource {tenantId: $tenantId, scanId: $scanId}) RETURN count(n) AS n", {
        tenantId,
        scanId,
      }),
    );
    return Number(result.records[0]?.get("n") ?? 0);
  } finally {
    await session.close();
  }
}

beforeAll(async () => {
  if (!HAS_INFRA) return;
  try {
    await system.insert(schema.tenants).values({ id: tenantId, name: "graphRetention.test" });
    await seedConnection(accountA);
    await seedConnection(accountB);
    available = true;
  } catch (err) {
    // Printed, not swallowed: a seeding failure that says nothing turns the
    // first assertion below into a riddle. Precedent: tenantIsolation.test.ts.
    console.warn("Graph retention suite skipped:", err instanceof Error ? err.message : err);
  }
}, 120_000);

afterAll(async () => {
  if (!available) return;
  await sweepSupersededScans(tenantId, []).catch(() => 0);
  // The tenant cascades to its connections, scans and snapshots.
  await system.delete(schema.tenants).where(eq(schema.tenants.id, tenantId));
});

describe.runIf(HAS_INFRA)("a tenant's other accounts", () => {
  it("were both projected to begin with", async () => {
    // Without this every assertion below is satisfiable by a graph that was
    // never written, which is precisely the state the bug produced.
    expect(available, "Postgres or Neo4j is not reachable, so none of this was checked").toBe(true);
    if (!available) return;

    expect(await nodesFor(accountA.scanId)).toBe(1);
    expect(await nodesFor(accountB.scanId)).toBe(1);
  });

  it("keeps two scopes per connection, and names them for every connection", async () => {
    if (!available) return;
    const keep = await projectedScanIdsToKeep(tenantId);
    // Both accounts, derived from the database rather than from a caller's
    // idea of which connection is interesting.
    expect(keep).toContain(accountA.scanId);
    expect(keep).toContain(accountB.scanId);
  });

  it("survive a sweep run while the other account is scanned", async () => {
    if (!available) return;

    /**
     * Exactly what `runScanJob` does after projecting: derive the keep-list,
     * then sweep. With the old hand-assembled list - this scan and the one
     * before it - account A's single node was deleted here.
     */
    await sweepSupersededScans(tenantId, await projectedScanIdsToKeep(tenantId));

    expect(await nodesFor(accountB.scanId), "the scanned account lost its own graph").toBe(1);
    expect(
      await nodesFor(accountA.scanId),
      "scanning one account deleted another account's graph, and Postgres still says it is " +
        "projected - so that account now renders as an empty graph rather than an error",
    ).toBe(1);
  });
});

describe("the scan job's keep-list", () => {
  it("is derived rather than built at the call site", () => {
    /**
     * A lexical check, because the integration assertions above pass whatever
     * `runScanJob` happens to pass: they call the sweep themselves. The defect
     * was the *caller's* list, so the caller is what needs pinning.
     *
     * Runs without infrastructure, so it holds in CI's fast job too.
     */
    const runScanJob = readFileSync(
      fileURLToPath(new URL("./runScanJob.ts", import.meta.url)),
      "utf8",
    );
    expect(
      runScanJob,
      "runScanJob no longer derives the keep-list with projectedScanIdsToKeep. A list assembled " +
        "at the call site omits the tenant's other connections, and the sweep matches on the " +
        "tenant - so their graphs are deleted.",
    ).toContain("projectedScanIdsToKeep(scope.tenantId)");
  });
});
