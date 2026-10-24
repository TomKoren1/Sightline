/**
 * A large account, end to end, against time budgets.
 *
 * The demo estate is collected from moto once, multiplied to about
 * `LOAD_RESOURCES` resources (50,000 by default) plus a crowd of instances
 * behind one security group, and then put through everything a real scan of
 * that size goes through: analysis, the snapshot write, findings sync, and
 * every query the dashboard and the agent make against the result.
 *
 * `LOAD_ACCOUNTS` copies the scan, server-side, into that many connections in
 * all, so the queries run against tables holding many accounts. Peak memory is
 * sampled through analysis and the write, against a per-resource budget.
 *
 * Opt-in with `LOAD_TEST=1`: it takes about a minute and needs Postgres and
 * moto. Budgets are several times what a laptop measures, so a failure means
 * a different order of cost, not a busy machine. The numbers are printed
 * either way; they are the useful output.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { INTERNET_ARN, type ScanResult } from "@sightline/shared";
import { seed } from "@sightline/mock-aws";

import { cfg, isMock, MOCK_EXTERNAL_ID } from "../config.js";
import * as q from "../db/graph.js";
import { syncFindings } from "../db/findings.js";
import { GraphService } from "../graph/graph.service.js";
import { sql } from "drizzle-orm";
import { system } from "../db/postgres.js";
import {
  createScanRun,
  markProjected,
  refreshSnapshotStatistics,
  saveScanResult,
} from "../db/repository.js";
import * as schema from "../db/schema.js";
import { annotate } from "../scan/pipeline.js";
import { collectEstate } from "../scan/runner.js";
import { asConnectionId, asTenantId, type ScanId } from "../tenancy/ids.js";
import { replicateEstate } from "./replicate.js";

const ENABLED = process.env["LOAD_TEST"] === "1";
const TARGET = Number(process.env["LOAD_RESOURCES"] ?? 50_000);
/** Instances behind one group: the shape that makes edge growth visible. */
const CROWD = 2_000;
/** Connections holding a copy of the scan, this one included. */
const ACCOUNTS = Math.max(1, Number(process.env["LOAD_ACCOUNTS"] ?? 1));

/**
 * Milliseconds, per step. The scale they assume is 50,000 resources; another
 * `LOAD_RESOURCES` scales them linearly, which is the growth being asserted.
 */
const BUDGET_MS = {
  annotate: 15_000,
  save: 90_000,
  syncFindings: 15_000,
  /** Each dashboard or agent query, singly. */
  query: 3_000,
} as const;
/**
 * Peak heap per resource while the estate is analysed and written - the
 * worker's real ceiling, since it holds the whole estate at once. 50,000
 * resources measure about 10 KB each.
 */
const HEAP_BYTES_PER_RESOURCE = 30_000;
/** The worker's memory limit in deploy/k8s/base/app.yaml. */
const WORKER_LIMIT_BYTES = 2 * 1024 ** 3;
/**
 * Budgets assume the database is next to the process, as in CI and in the
 * deployment. Across a slow link the snapshot write is bandwidth, not code -
 * 150 MB at 2 MB/s is over a minute - so `LOAD_BUDGET_SCALE` widens every
 * budget for such a run, explicitly, instead of the defaults being loose.
 */
const scale = Math.max(1, TARGET / 50_000) * Number(process.env["LOAD_BUDGET_SCALE"] ?? 1);

const tenantId = asTenantId(randomUUID());
const connectionId = asConnectionId(randomUUID());
const scope = { tenantId, connectionId };

const timings: { step: string; ms: number; detail?: string }[] = [];
async function timed<T>(step: string, fn: () => Promise<T> | T, detail?: (t: T) => string) {
  const started = performance.now();
  const value = await fn();
  const ms = Math.round(performance.now() - started);
  timings.push({ step, ms, ...(detail ? { detail: detail(value) } : {}) });
  return { value, ms };
}

let skipReason: string | null = ENABLED ? null : "LOAD_TEST is not 1";

/** The highest heap and RSS seen since `start`, sampled every 25 ms. */
function memoryPeak() {
  const peak = { heap: 0, rss: 0 };
  const sample = () => {
    const m = process.memoryUsage();
    peak.heap = Math.max(peak.heap, m.heapUsed);
    peak.rss = Math.max(peak.rss, m.rss);
  };
  sample();
  const timer = setInterval(sample, 25);
  return {
    stop() {
      clearInterval(timer);
      sample();
      return peak;
    },
  };
}
let peakHeap = 0;
let annotated: ScanResult;
let scanId: ScanId;

beforeAll(async () => {
  if (!ENABLED) return;
  if (!isMock()) {
    // Same refusal as the ground-truth suite: a test run never scans a real account.
    skipReason = "AWS_MODE is not 'mock'; refusing to collect from a real account.";
    return;
  }
  // Parsed config, not the environment: config removes the variable at import.
  const endpoint = cfg.AWS_ENDPOINT_URL;
  const target = {
    connectionId,
    kind: "demo" as const,
    roleArn: `arn:aws:iam::${process.env["MOCK_AWS_ACCOUNT_ID"] ?? "123456789012"}:role/SightlineReadOnlyRole`,
    externalId: MOCK_EXTERNAL_ID,
    endpoint,
    pinnedAccountId: null,
    regions: null,
  };

  let base = await collectEstate({ target, scanId: "load" });
  if (base.collected.resources.length === 0) {
    await seed();
    base = await collectEstate({ target, scanId: "load" });
  }

  const memory = memoryPeak();
  const per = base.collected.resources.length;
  const copies = Math.max(1, Math.ceil((TARGET - CROWD) / per));
  const big = replicateEstate(base.collected, { copies, crowd: CROWD });
  ({ value: annotated } = await timed(
    "annotate",
    () => annotate(base.accountId, base.regions, big),
    (r) =>
      `${r.resources.length.toLocaleString()} resources, ` +
      `${r.relationships.length.toLocaleString()} relationships (${copies} copies of ${per} + ${CROWD})`,
  ));

  await system.insert(schema.tenants).values({ id: tenantId, name: "load.test" });
  await system.insert(schema.connections).values({
    id: connectionId,
    tenantId,
    kind: "demo",
    label: "load.test",
    externalIdSource: "demo",
  });
  scanId = await createScanRun(scope, base.accountId, base.regions);
  await timed("save", () =>
    saveScanResult(scope, scanId, {
      status: "succeeded",
      units: base.units,
      resources: annotated.resources,
      relationships: annotated.relationships,
      apiCalls: 0,
    }),
  );
  const peak = memory.stop();
  peakHeap = peak.heap;
  const mib = (b: number) => `${Math.round(b / 1024 ** 2).toLocaleString()} MiB`;
  const perResource = Math.round(peak.heap / annotated.resources.length);
  timings.push({
    step: "peak memory",
    ms: 0,
    detail:
      `heap ${mib(peak.heap)}, rss ${mib(peak.rss)}: ${perResource.toLocaleString()} bytes a resource, ` +
      `so the worker's 2 GiB fits about ${Math.floor(WORKER_LIMIT_BYTES / perResource).toLocaleString()}`,
  });

  // As the scan job does after a write this size.
  await timed("refresh statistics", () => refreshSnapshotStatistics());
  await timed(
    "syncFindings",
    () => syncFindings(scope, scanId, true),
    (r) => `${r.opened.toLocaleString()} opened`,
  );
  await markProjected(scope, scanId);

  // Further accounts, copied in Postgres rather than written again: the point
  // is the size of the tables the queries filter, not the write.
  await timed(
    "copy to more accounts",
    async () => {
      for (let i = 1; i < ACCOUNTS; i++) {
        const other = asConnectionId(randomUUID());
        await system.insert(schema.connections).values({
          id: other,
          tenantId,
          kind: "demo",
          label: `load.test ${i}`,
          externalIdSource: "demo",
        });
        const copy = await createScanRun(
          { tenantId, connectionId: other },
          base.accountId,
          base.regions,
        );
        await system.execute(sql`
          INSERT INTO resource_snapshots
                 (tenant_id, scan_id, arn, kind, name, region, account_id, tags, properties, derived, fingerprint)
          SELECT tenant_id, ${copy}, arn, kind, name, region, account_id, tags, properties, derived, fingerprint
            FROM resource_snapshots WHERE scan_id = ${scanId}`);
        await system.execute(sql`
          INSERT INTO relationship_snapshots (tenant_id, scan_id, from_arn, to_arn, rel_type, properties)
          SELECT tenant_id, ${copy}, from_arn, to_arn, rel_type, properties
            FROM relationship_snapshots WHERE scan_id = ${scanId}`);
      }
      await refreshSnapshotStatistics();
    },
    () =>
      `${ACCOUNTS} accounts, ${(annotated.resources.length * ACCOUNTS).toLocaleString()} resources in all`,
  );

  // What the scan costs to keep, after Postgres's own compression.
  const { rows } = await system.execute<{ bytes: string }>(sql`
    SELECT (SELECT coalesce(sum(pg_column_size(r.*)), 0) FROM resource_snapshots r
             WHERE r.scan_id = ${scanId})
         + (SELECT coalesce(sum(pg_column_size(e.*)), 0) FROM relationship_snapshots e
             WHERE e.scan_id = ${scanId}) AS bytes`);
  const mb = Number(rows[0]?.bytes ?? 0) / 1024 / 1024;
  timings.push({ step: "stored size", ms: 0, detail: `${mb.toFixed(1)} MB of rows for this scan` });
}, 600_000 * scale);

afterAll(async () => {
  if (!ENABLED || skipReason) return;
  await system.delete(schema.tenants).where(eq(schema.tenants.id, tenantId));
  const width = Math.max(...timings.map((t) => t.step.length));
  // Straight to stdout: vitest hides console output from passing tests, and
  // the numbers are the point of a passing run.
  process.stdout.write(
    `\nLarge-account load test (${TARGET.toLocaleString()} target resources)\n` +
      timings
        .map((t) => `  ${t.step.padEnd(width)}  ${String(t.ms).padStart(7)} ms  ${t.detail ?? ""}`)
        .join("\n") +
      "\n",
  );
});

describe.runIf(ENABLED)("a large account", () => {
  const graph = () => ({ tenantId, scanId });

  it("reaches the size it was asked for", () => {
    if (skipReason) return console.warn(`load test skipped: ${skipReason}`);
    expect(annotated.resources.length).toBeGreaterThanOrEqual(TARGET);
  });

  it("keeps reachability edges linear in the crowd behind one group", () => {
    if (skipReason) return;
    const canReach = annotated.relationships.filter((e) => e.type === "CAN_REACH").length;
    // Quadratic growth over a 2,000-host group alone would be four million edges.
    expect(canReach).toBeLessThan(annotated.resources.length * 4);
  });

  it("holds the estate within its memory budget", () => {
    if (skipReason) return;
    const perResource = peakHeap / annotated.resources.length;
    expect(perResource, `${Math.round(perResource)} bytes a resource`).toBeLessThan(
      HEAP_BYTES_PER_RESOURCE,
    );
  });

  it("analyses, saves and syncs within budget", () => {
    if (skipReason) return;
    for (const step of ["annotate", "save", "syncFindings"] as const) {
      const t = timings.find((x) => x.step === step)!;
      expect(t.ms, `${step} took ${t.ms} ms`).toBeLessThan(BUDGET_MS[step] * scale);
    }
  });

  /** Every read the dashboard makes on load, and the agent's heaviest tools. */
  const QUERIES: [string, () => Promise<unknown>][] = [
    ["summary", () => q.summariseAccount(graph())],
    ["graph (500 nodes)", () => q.fetchGraph(graph(), { limit: 500 })],
    ["graph groups (the large-account overview)", () => q.graphGroups(graph())],
    [
      "the largest group, findings first (300 nodes)",
      async () => {
        const [largest] = (await q.graphGroups(graph())).sort((a, b) => b.count - a.count);
        return largest ? q.fetchGraph(graph(), { group: largest.id, limit: 300 }) : null;
      },
    ],
    [
      "a resource's neighbourhood",
      async () => {
        const db = annotated.resources.find((r) => r.kind === "RdsInstance");
        return db ? q.neighbourhood(graph(), db.arn) : null;
      },
    ],
    ["public resources", () => q.findPublicResources(graph(), { limit: 50 })],
    ["admin principals", () => q.findAdminPrincipals(graph(), { limit: 50 })],
    ["idle", () => q.findIdleResources(graph(), { limit: 50 })],
    ["open security groups", () => q.findOpenSecurityGroups(graph(), { limit: 50 })],
    ["unguarded buckets", () => q.findUnprotectedBuckets(graph(), { limit: 50 })],
    ["findings panel (whole endpoint)", () => new GraphService().findings(scope)],
    ["search", () => q.searchResources(graph(), { text: "prod" })],
    [
      "agent: a page of public resources, with counts",
      () => q.pageOf("findPublicResources", graph(), { limit: 50, offset: 50 }),
    ],
    [
      "reachable from the internet",
      () => q.findReachableFrom(graph(), { source: INTERNET_ARN, maxHops: 3 }),
    ],
    [
      "paths to a database",
      async () => {
        const db = annotated.resources.find((r) => r.kind === "RdsInstance");
        return db ? q.findNetworkPaths(graph(), { target: db.arn }) : null;
      },
    ],
  ];

  it.each(QUERIES)("answers %s within budget", async (name, run) => {
    if (skipReason) return;
    const { ms } = await timed(name, run);
    expect(ms, `${name} took ${ms} ms`).toBeLessThan(BUDGET_MS.query * scale);
  });
});
