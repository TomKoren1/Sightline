/**
 * The scan write path, round-tripped.
 *
 * `saveScanResult` is the riskiest thing the ORM port touched: a transaction
 * wrapping three different kinds of write, two of them batched by hand because
 * Postgres caps a statement at 65535 parameters. Before the port it was strings
 * of SQL with `$1, $2, …` placeholder arithmetic; nothing read it back and
 * compared, so an off-by-one in that arithmetic would have shown up as missing
 * resources in the UI rather than as a failing test.
 *
 * So this writes a scan, reads it back, and asserts it came out the way it went
 * in — deliberately with more resources than `BATCH_SIZE`, because a batching
 * bug that only appears on the second chunk is the one worth catching.
 *
 * Runs against the configured database and cleans up after itself. The scan ids
 * are generated and the account id is obviously synthetic, so it cannot collide
 * with real scan history, and `ON DELETE CASCADE` removes the snapshots with
 * the run.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Relationship, Resource } from "@sightline/shared";

import { db } from "./postgres.js";
import { scanRuns } from "./schema.js";
import {
  createScanRun,
  diffScans,
  failScanRun,
  getScan,
  loadRelationships,
  loadResources,
  saveScanResult,
} from "./repository.js";

const HAS_INFRA = !process.env["SKIP_INTEGRATION"];

const ACCOUNT = "000000000000";

/** More than one batch of 500, so the chunking boundary is actually crossed. */
const COUNT = 1_200;

function resourceAt(i: number, publicFlag = false): Resource {
  return {
    arn: `arn:aws:ec2:us-east-1:${ACCOUNT}:instance/i-${String(i).padStart(10, "0")}`,
    kind: "Ec2Instance",
    name: `repo-test-${i}`,
    region: i % 3 === 0 ? "eu-west-1" : "us-east-1",
    accountId: ACCOUNT,
    tags: { Index: String(i) },
    properties: { instanceType: "t3.micro", ordinal: i },
    derived: { isPublic: publicFlag },
  };
}

const created: string[] = [];

async function newScan(): Promise<string> {
  const id = await createScanRun(ACCOUNT, ["us-east-1", "eu-west-1"]);
  created.push(id);
  return id;
}

let scanId = "";
let resources: Resource[] = [];
let relationships: Relationship[] = [];
let available = false;

beforeAll(async () => {
  try {
    await db.execute("SELECT 1");
  } catch {
    return;
  }

  resources = Array.from({ length: COUNT }, (_, i) => resourceAt(i));
  relationships = resources.slice(1).map((r, i) => ({
    from: resources[i]!.arn,
    to: r.arn,
    type: "CAN_REACH",
    properties: { ports: "tcp/443", hop: i },
  }));

  scanId = await newScan();
  await saveScanResult(scanId, {
    status: "succeeded",
    units: [
      {
        service: "ec2",
        region: "us-east-1",
        status: "succeeded",
        resourceCount: COUNT,
        apiCalls: 7,
        durationMs: 11,
      },
      // A global service, so the 'global' sentinel that lets region take part
      // in the primary key is exercised rather than assumed.
      {
        service: "iam",
        region: null,
        status: "succeeded",
        resourceCount: 0,
        apiCalls: 2,
        durationMs: 3,
      },
    ],
    resources,
    relationships,
    apiCalls: 9,
  });
  available = true;
}, 120_000);

afterAll(async () => {
  for (const id of created) {
    await db
      .delete(scanRuns)
      .where(eq(scanRuns.id, id))
      .catch(() => {});
  }
});

describe.runIf(HAS_INFRA)("saving and reading a scan", () => {
  it("writes every resource, across the batching boundary", async () => {
    if (!available) return;
    const back = await loadResources(scanId);
    expect(back).toHaveLength(COUNT);

    // Compared by content, not by count: a batching bug can write the right
    // number of rows with the wrong values in them, which counting hides.
    const byArn = new Map(back.map((r) => [r.arn, r]));
    for (const original of resources) {
      expect(byArn.get(original.arn), `${original.arn} was not written`).toEqual(original);
    }
  });

  it("writes every relationship", async () => {
    if (!available) return;
    const back = await loadRelationships(scanId);
    expect(back).toHaveLength(relationships.length);
    const seen = new Set(back.map((r) => `${r.from}|${r.to}|${r.type}`));
    for (const rel of relationships) {
      expect(seen.has(`${rel.from}|${rel.to}|${rel.type}`)).toBe(true);
    }
  });

  it("records the run and both units, with null restored for a global service", async () => {
    if (!available) return;
    const run = await getScan(scanId);
    expect(run).not.toBeNull();
    expect(run!.status).toBe("succeeded");
    expect(run!.resourceCount).toBe(COUNT);
    expect(run!.relationshipCount).toBe(relationships.length);
    expect(run!.regions).toEqual(["us-east-1", "eu-west-1"]);

    const iam = run!.units.find((u) => u.service === "iam");
    // Stored as 'global' so it can be part of the primary key, and it has to
    // come back as null or the UI renders a region that does not exist.
    expect(iam?.region).toBeNull();
    expect(run!.units.find((u) => u.service === "ec2")?.region).toBe("us-east-1");
  });

  it("is atomic: a failure inside the transaction writes nothing", async () => {
    if (!available) return;
    const id = await newScan();
    await expect(
      saveScanResult(id, {
        status: "succeeded",
        units: [],
        // A resource with no ARN violates NOT NULL, and it is in the second
        // batch — so anything written by the first batch must be rolled back.
        resources: [
          ...Array.from({ length: 600 }, (_, i) => resourceAt(100_000 + i)),
          { ...resourceAt(999_999), arn: null as unknown as string },
        ],
        relationships: [],
        apiCalls: 0,
      }),
    ).rejects.toThrow();

    expect(
      await loadResources(id),
      "the first batch survived a failure in the second, so the transaction is not covering both",
    ).toHaveLength(0);
    const run = await getScan(id);
    expect(run?.status, "the run was marked succeeded despite the failure").toBe("running");
  });

  it("marks a failed run", async () => {
    if (!available) return;
    const id = await newScan();
    await failScanRun(id, "something went wrong");
    const run = await getScan(id);
    expect(run?.status).toBe("failed");
    expect(run?.error).toBe("something went wrong");
  });
});

describe.runIf(HAS_INFRA)("diffing two scans", () => {
  it("reports what was added, removed and changed, and nothing else", async () => {
    if (!available) return;

    const first = await newScan();
    const second = await newScan();

    const base = Array.from({ length: 5 }, (_, i) => resourceAt(2_000 + i));
    await saveScanResult(first, {
      status: "succeeded",
      units: [],
      resources: base,
      relationships: [],
      apiCalls: 0,
    });

    // One dropped, one new, one whose derived verdict flipped, two untouched.
    const next = [
      base[0]!,
      base[1]!,
      base[2]!,
      { ...base[3]!, derived: { isPublic: true } },
      resourceAt(2_100),
    ];
    await saveScanResult(second, {
      status: "succeeded",
      units: [],
      resources: next,
      relationships: [],
      apiCalls: 0,
    });

    const diff = await diffScans(first, second);
    expect(diff.added.map((r) => r.name)).toEqual(["repo-test-2100"]);
    expect(diff.removed.map((r) => r.name)).toEqual(["repo-test-2004"]);
    expect(diff.modified.map((r) => r.name)).toEqual(["repo-test-2003"]);

    // The point of the fingerprint: only the row that really changed is
    // compared field by field, and it names the field rather than the row.
    expect(diff.modified[0]!.changedFields).toEqual([
      { field: "derived.isPublic", before: false, after: true },
    ]);
  });
});
