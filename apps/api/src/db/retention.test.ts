/**
 * Scan history is bounded: old scans go, with their snapshots, and nothing a
 * reader might be looking at goes with them.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";

import { system } from "./postgres.js";
import * as schema from "./schema.js";
import { pruneScanHistory } from "./repository.js";
import { asConnectionId, asTenantId } from "../tenancy/ids.js";

const HAS_INFRA = !process.env["SKIP_INTEGRATION"];

const tenantId = asTenantId(randomUUID());
const connectionId = asConnectionId(randomUUID());
const otherConnection = asConnectionId(randomUUID());

/** Oldest first. `projected` marks the scans whose graph was published. */
const plan = [
  { name: "oldest-projected", status: "succeeded", projected: true },
  { name: "old-running", status: "running", projected: false },
  { name: "old-failed", status: "failed", projected: false },
  { name: "older", status: "succeeded", projected: false },
  { name: "previous-projected", status: "succeeded", projected: true },
  { name: "newer", status: "partial", projected: false },
  { name: "newest", status: "succeeded", projected: false },
] as const;

const ids = new Map<string, string>();
const otherScan = randomUUID();
let available = false;

beforeAll(async () => {
  if (!HAS_INFRA) return;
  try {
    await system.insert(schema.tenants).values({ id: tenantId, name: "retention.test" });
    for (const id of [connectionId, otherConnection]) {
      await system.insert(schema.connections).values({
        id,
        tenantId,
        kind: "demo",
        label: `retention ${id}`,
        externalIdSource: "demo",
      });
    }
    const base = Date.now() - plan.length * 60_000;
    for (const [i, scan] of plan.entries()) {
      const id = randomUUID();
      ids.set(scan.name, id);
      const at = new Date(base + i * 60_000);
      await system.insert(schema.scanRuns).values({
        id,
        tenantId,
        connectionId,
        accountId: "123456789012",
        status: scan.status,
        startedAt: at,
        projectedAt: scan.projected ? at : null,
      });
      await system.insert(schema.resourceSnapshots).values({
        tenantId,
        scanId: id,
        arn: `arn:aws:s3:::${scan.name}`,
        kind: "S3Bucket",
        name: scan.name,
        region: null,
        accountId: "123456789012",
        fingerprint: randomUUID().replace(/-/g, ""),
      });
    }
    // Another account's old scan, which pruning this one must not touch.
    await system.insert(schema.scanRuns).values({
      id: otherScan,
      tenantId,
      connectionId: otherConnection,
      accountId: "210987654321",
      status: "succeeded",
      startedAt: new Date(base - 3_600_000),
    });
    available = true;
  } catch (err) {
    console.warn("retention.test skipped:", err);
  }
});

afterAll(async () => {
  if (available) await system.delete(schema.tenants).where(eq(schema.tenants.id, tenantId));
});

describe.runIf(HAS_INFRA)("pruneScanHistory", () => {
  it("keeps the newest, the live graphs and the running scan, and deletes the rest", async () => {
    if (!available) return;
    const deleted = await pruneScanHistory({ tenantId, connectionId }, 2);

    const remaining = await system
      .select({ id: schema.scanRuns.id })
      .from(schema.scanRuns)
      .where(eq(schema.scanRuns.connectionId, connectionId));
    const names = plan
      .map((p) => p.name)
      .filter((name) => remaining.some((r) => r.id === ids.get(name)));

    expect(names.sort()).toEqual(
      ["newest", "newer", "previous-projected", "oldest-projected", "old-running"].sort(),
    );
    expect(deleted).toBe(2);
  });

  it("takes the deleted scans' snapshots with them", async () => {
    if (!available) return;
    const gone = [ids.get("older")!, ids.get("old-failed")!];
    const snapshots = await system
      .select({ scanId: schema.resourceSnapshots.scanId })
      .from(schema.resourceSnapshots)
      .where(inArray(schema.resourceSnapshots.scanId, gone));
    expect(snapshots).toEqual([]);
  });

  it("leaves other accounts' history alone", async () => {
    if (!available) return;
    const [other] = await system
      .select({ id: schema.scanRuns.id })
      .from(schema.scanRuns)
      .where(eq(schema.scanRuns.id, otherScan));
    expect(other).toBeDefined();
  });
});
