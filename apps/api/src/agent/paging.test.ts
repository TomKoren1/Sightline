/**
 * List tools page through a large answer instead of truncating it, and say
 * how big the whole answer is - counted by Postgres, not by the model.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Resource } from "@sightline/shared";

import { system } from "../db/postgres.js";
import * as schema from "../db/schema.js";
import { createScanRun, saveScanResult } from "../db/repository.js";
import { asConnectionId, asScanId, asTenantId } from "../tenancy/ids.js";
import { pageLine } from "./agent.js";
import { encodeCursor, runTool, type ToolContext } from "./tools.js";

const HAS_INFRA = !process.env["SKIP_INTEGRATION"];
const tenantId = asTenantId(randomUUID());
const connectionId = asConnectionId(randomUUID());
const scope = { tenantId, connectionId };
let available = false;
let ctx: ToolContext;

/** 120 public buckets over two regions, and 5 public queues. */
function estate(): Resource[] {
  const bucket = (i: number): Resource => ({
    arn: `arn:aws:s3:::bucket-${String(i).padStart(3, "0")}`,
    kind: "S3Bucket",
    name: `bucket-${String(i).padStart(3, "0")}`,
    region: i % 3 === 0 ? "eu-west-1" : "us-east-1",
    accountId: "123456789012",
    tags: {},
    properties: {},
    derived: { isPublic: true, publicReason: "policy grants s3:GetObject to *" },
  });
  const queue = (i: number): Resource => ({
    arn: `arn:aws:sqs:us-east-1:123456789012:queue-${i}`,
    kind: "SqsQueue",
    name: `queue-${i}`,
    region: "us-east-1",
    accountId: "123456789012",
    tags: {},
    properties: {},
    derived: { isPublic: true, publicReason: "policy allows sqs:SendMessage from *" },
  });
  return [
    ...Array.from({ length: 120 }, (_, i) => bucket(i)),
    ...Array.from({ length: 5 }, (_, i) => queue(i)),
  ];
}

beforeAll(async () => {
  if (!HAS_INFRA) return;
  try {
    await system.insert(schema.tenants).values({ id: tenantId, name: "paging.test" });
    await system.insert(schema.connections).values({
      id: connectionId,
      tenantId,
      kind: "demo",
      label: "paging.test",
      externalIdSource: "demo",
    });
    const scanId = await createScanRun(scope, "123456789012", ["us-east-1", "eu-west-1"]);
    await saveScanResult(scope, scanId, {
      status: "succeeded",
      units: [],
      resources: estate(),
      relationships: [],
      apiCalls: 0,
    });
    ctx = { scope, graph: { tenantId, scanId: asScanId(scanId) } } as ToolContext;
    available = true;
  } catch (err) {
    console.warn("paging.test skipped:", err);
  }
});

afterAll(async () => {
  if (available) await system.delete(schema.tenants).where(eq(schema.tenants.id, tenantId));
});

describe.runIf(HAS_INFRA)("list tools", () => {
  it("report the whole answer's size and shape on the first page", async () => {
    if (!available) return;
    const result = await runTool(ctx, "find_public_resources", {} as never);
    expect(result.rows).toHaveLength(50);
    expect(result.page).toMatchObject({ total: 125, offset: 0 });
    expect(result.page?.byKind).toEqual([
      { kind: "S3Bucket", count: 120 },
      { kind: "SqsQueue", count: 5 },
    ]);
    expect(result.page?.byRegion).toEqual(
      expect.arrayContaining([
        { region: "us-east-1", count: 85 },
        { region: "eu-west-1", count: 40 },
      ]),
    );
  });

  it("page through every row once, in order, with the cursor", async () => {
    if (!available) return;
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let pages = 0; pages < 10; pages++) {
      const input = { limit: 40, ...(cursor ? { cursor } : {}) } as never;
      const { rows, page } = await runTool(ctx, "find_public_resources", input);
      seen.push(...rows.map((r) => (r as { arn: string }).arn));
      const next = page!.offset + rows.length;
      if (next >= page!.total) break;
      cursor = encodeCursor(ctx.graph.scanId, next);
    }
    expect(seen).toHaveLength(125);
    expect(new Set(seen).size).toBe(125);
  });

  it("filter, and count only what the filter kept", async () => {
    if (!available) return;
    const { page } = await runTool(ctx, "find_public_resources", { kind: "SqsQueue" } as never);
    expect(page).toMatchObject({ total: 5, byKind: [{ kind: "SqsQueue", count: 5 }] });
  });

  it("refuse a cursor from another scan rather than page through it", async () => {
    if (!available) return;
    const cursor = encodeCursor(randomUUID(), 40);
    const result = await runTool(ctx, "find_public_resources", { cursor } as never);
    expect(result.rows).toEqual([]);
    expect(result.note).toMatch(/another scan/);
  });
});

describe("the page line the model reads", () => {
  const page = {
    total: 125,
    offset: 50,
    byKind: [
      { kind: "S3Bucket", count: 120 },
      { kind: "SqsQueue", count: 5 },
    ],
    byRegion: [{ region: null, count: 125 }],
  };

  it("continues from the first row the context budget dropped, not the last one fetched", () => {
    // 50 fetched, 12 fitted: the next page must start at row 63, or 38 rows
    // would never be seen by anyone.
    const line = pageLine(page, 12, "scan-1");
    expect(line).toContain("Rows 51-62 of 125.");
    expect(line).toContain(`cursor "${encodeCursor("scan-1", 62)}"`);
    expect(line).toContain("By kind: S3Bucket 120, SqsQueue 5.");
    expect(line).toContain("By region: global 125.");
  });

  it("offers no cursor on the last page", () => {
    expect(pageLine({ ...page, offset: 100 }, 25, "scan-1")).not.toContain("cursor");
  });
});
