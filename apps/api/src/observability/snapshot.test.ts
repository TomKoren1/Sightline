/**
 * The gauge that would have caught a graph being deleted behind Postgres' back.
 *
 * Saturday's bug: a sweep removed other accounts' graphs while `projected_at`
 * went on naming those scans, so the only symptom was an empty graph that read
 * as "your AWS account contains nothing". `countScope` was written for this
 * comparison and had no caller.
 *
 * So the test projects a graph, agrees, then deletes it behind Postgres' back
 * and asserts the gauge notices. Requires Postgres and Neo4j.
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Relationship, Resource } from "@sightline/shared";

import { getDriver, projectGraph } from "../db/neo4j.js";
import { system } from "../db/postgres.js";
import * as schema from "../db/schema.js";
import { asScanId, asTenantId } from "../tenancy/ids.js";
import { refreshConnections, refreshGraphReconciliation, refreshQueueDepth } from "./snapshot.js";

const HAS_INFRA = !process.env["SKIP_INTEGRATION"];

const tenantId = asTenantId(randomUUID());
const connectionId = randomUUID();
const scanId = asScanId(randomUUID());
const RESOURCES = 3;

let available = false;

function inventory(): { resources: Resource[]; relationships: Relationship[] } {
  return {
    resources: Array.from({ length: RESOURCES }, (_, i) => ({
      arn: `arn:aws:s3:::snapshot-test-${i}`,
      kind: "S3Bucket",
      name: `snapshot-test-${i}`,
      region: null,
      accountId: "123456789012",
      derived: {},
      properties: {},
      tags: {},
    })),
    relationships: [],
  };
}

beforeAll(async () => {
  if (!HAS_INFRA) return;
  try {
    await system.insert(schema.tenants).values({ id: tenantId, name: "snapshot.test" });
    await system.insert(schema.connections).values({
      id: connectionId,
      tenantId,
      kind: "demo",
      label: "snapshot",
      externalIdSource: "demo",
      status: "verified",
    });
    await system.insert(schema.scanRuns).values({
      id: scanId,
      tenantId,
      connectionId,
      accountId: "123456789012",
      status: "succeeded",
      startedAt: new Date(),
      projectedAt: new Date(),
      resourceCount: RESOURCES,
    });
    const { resources, relationships } = inventory();
    await projectGraph({ tenantId, scanId }, resources, relationships);
    available = true;
  } catch (err) {
    console.warn("Snapshot suite skipped:", err instanceof Error ? err.message : err);
  }
}, 120_000);

afterAll(async () => {
  if (!available) return;
  const session = getDriver().session();
  try {
    await session.executeWrite((tx) =>
      tx.run("MATCH (n:Resource {tenantId: $tenantId}) DETACH DELETE n", { tenantId }),
    );
  } finally {
    await session.close();
  }
  await system.delete(schema.tenants).where(eq(schema.tenants.id, tenantId));
});

/** Nodes for this scan, deleted the way the sweep deleted them. */
async function deleteGraph(): Promise<void> {
  const session = getDriver().session();
  try {
    await session.executeWrite((tx) =>
      tx.run("MATCH (n:Resource {tenantId: $tenantId, scanId: $scanId}) DETACH DELETE n", {
        tenantId,
        scanId,
      }),
    );
  } finally {
    await session.close();
  }
}

describe.runIf(HAS_INFRA)("the reconciliation gauge", () => {
  it("was able to project a graph to compare against", async () => {
    // Without this the mismatch assertion below would pass against a graph
    // that was never written, which is the state it is meant to detect.
    expect(available, "Postgres or Neo4j is not reachable, so none of this was checked").toBe(true);
  });

  it("counts no mismatch while the two stores agree", async () => {
    if (!available) return;
    // Other tenants' data may legitimately disagree, so this asserts the
    // count does not include *this* fixture rather than that it is zero.
    const before = await refreshGraphReconciliation();
    expect(before).toBeGreaterThanOrEqual(0);

    await deleteGraph();
    const after = await refreshGraphReconciliation();
    expect(
      after,
      "a graph deleted behind Postgres' back must raise the mismatch count - this is the signal " +
        "whose absence made a deleted graph look like an empty AWS account",
    ).toBe(before + 1);
  });

  it("reports queue depth and connection counts without throwing", async () => {
    if (!available) return;
    // Shape, not value: other tests are creating and draining jobs
    // concurrently, so any assertion about the number would be a race.
    await expect(refreshQueueDepth()).resolves.toBeUndefined();
    await expect(refreshConnections()).resolves.toBeUndefined();
  });
});
