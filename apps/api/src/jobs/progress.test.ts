/**
 * The events a client sees, derived from rows rather than from a live scan.
 *
 * Which is the point of the whole design and so the thing to test directly:
 * seed `scan_jobs`, `scan_runs` and `scan_units` into a state a scan would have
 * produced, and check that what comes out is a complete and correct account of
 * it. No scan is run, no AWS is touched, and nothing depends on timing.
 *
 * The property that matters most here is **completeness regardless of when the
 * client joined**. The first implementation did not have it: it marked every
 * unit present at `scan.started` as already reported, so a stream that
 * connected after some units had finished never announced them. Against the
 * mock account, whose whole scan takes about three seconds, fourteen unit
 * events became one - a progress bar that jumps from nothing to done.
 *
 * Requires Postgres; skipped without it.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { ScanEvent, ScanUnit } from "@sightline/shared";

/**
 * Fixtures run on `system`, the owner connection.
 *
 * Setting up rows is not the thing under test, and under row-level security the
 * restricted role can only write rows for the tenant its connection names -
 * which makes seeding *two* tenants impossible on that path, and seeding two
 * tenants is the whole point of an isolation fixture. The functions under test
 * open their own tenant context, so what they do is still exercised exactly as
 * production does it.
 */
import { system } from "../db/postgres.js";
import { connections, scanJobs, scanRuns, scanUnits, tenants } from "../db/schema.js";
import { asConnectionId, asJobId, asTenantId } from "../core/ids.js";
import type { Scope } from "../core/scope.js";
import { streamScanEvents } from "./progress.js";
import { lockQueueForTest } from "./queueTestLock.js";

const HAS_INFRA = !process.env["SKIP_INTEGRATION"];

const tenantId = asTenantId(randomUUID());
const otherTenantId = asTenantId(randomUUID());
const scope: Scope = { tenantId, connectionId: asConnectionId(randomUUID()) };
const otherScope: Scope = {
  tenantId: otherTenantId,
  connectionId: asConnectionId(randomUUID()),
};

const ACCOUNT = "123456789012";
let available = false;
let releaseLock: (() => Promise<void>) | null = null;

beforeAll(async () => {
  if (!HAS_INFRA) return;
  try {
    await system.execute("SELECT 1");
  } catch {
    return;
  }
  // This file seeds `queued` jobs, which `queue.test.ts` would claim out from
  // under it if the two ran together. See queueTestLock for the whole story.
  releaseLock = await lockQueueForTest();
  available = true;

  for (const [id, name] of [
    [tenantId, "progress.test"],
    [otherTenantId, "progress.test.other"],
  ] as const) {
    await system.insert(tenants).values({ id, name });
  }
  for (const s of [scope, otherScope]) {
    await system.insert(connections).values({
      id: s.connectionId,
      tenantId: s.tenantId,
      kind: "demo",
      label: "progress.test",
      externalIdSource: "demo",
    });
  }
});

afterAll(async () => {
  if (available) {
    for (const id of [tenantId, otherTenantId]) {
      await system.delete(tenants).where(eq(tenants.id, id));
    }
  }
  await releaseLock?.();
});

type UnitStatus = ScanUnit["status"];

/** Seed a job, optionally with a run and units, in a given state. */
async function seed(options: {
  jobStatus: "queued" | "running" | "succeeded" | "partial" | "failed" | "cancelled";
  jobError?: string;
  run?: { status: "running" | "succeeded" | "partial" | "failed"; units: UnitStatus[] };
}) {
  await system.execute(sql`DELETE FROM scan_jobs`);
  await system.execute(sql`DELETE FROM scan_runs WHERE tenant_id = ${tenantId}`);

  const jobId = asJobId(randomUUID());
  let scanId: string | null = null;

  if (options.run) {
    scanId = randomUUID();
    await system.insert(scanRuns).values({
      id: scanId,
      tenantId,
      connectionId: scope.connectionId,
      accountId: ACCOUNT,
      status: options.run.status,
      startedAt: new Date(),
      regions: ["us-east-1"],
    });
    // One unit per status asked for, named so they are distinguishable.
    await system.insert(scanUnits).values(
      options.run.units.map((status, i) => ({
        tenantId,
        scanId: scanId!,
        service: (["ec2", "vpc", "s3", "iam", "rds", "lambda"] as const)[i % 6]!,
        region: `us-east-${i + 1}`,
        status,
        resourceCount: status === "succeeded" ? 3 : 0,
        apiCalls: 1,
        durationMs: 10,
      })),
    );
  }

  await system.insert(scanJobs).values({
    id: jobId,
    tenantId,
    connectionId: scope.connectionId,
    status: options.jobStatus,
    scanId,
    ...(options.jobError ? { error: options.jobError } : {}),
  });

  return { jobId, scanId };
}

/** Drain a stream to completion. Every case here reaches a terminal state. */
async function collect(
  target: Scope,
  jobId: ReturnType<typeof asJobId>,
  options: { idleLimitMs?: number; now?: () => number } = {},
): Promise<ScanEvent[]> {
  const events: ScanEvent[] = [];
  // 1ms polling: every fixture below is already terminal or becomes so on the
  // first pass, so this never actually waits - it just keeps the test fast.
  for await (const event of streamScanEvents(target, jobId, { pollMs: 1, ...options })) {
    events.push(event);
    // A runaway generator would otherwise hang the suite rather than fail it.
    if (events.length > 200) throw new Error("the stream did not stop");
  }
  return events;
}

const typesOf = (events: ScanEvent[]) => events.map((e) => e.type);

describe.runIf(HAS_INFRA)("the scan progress stream", () => {
  it("has a database to talk to", () => {
    expect(available, "Postgres is not reachable, so none of this was checked").toBe(true);
  });

  it("announces every finished unit exactly once, however late the client joined", async () => {
    if (!available) return;
    // A scan that is already complete: the hardest case for the bug this
    // guards, because at the moment of joining there is nothing left to watch.
    const { jobId } = await seed({
      jobStatus: "succeeded",
      run: { status: "succeeded", units: ["succeeded", "succeeded", "succeeded", "failed"] },
    });

    const events = await collect(scope, jobId);
    const finished = events.filter((e) => e.type === "unit.finished");

    expect(finished).toHaveLength(4);
    // One per unit, not one per poll: the count must not depend on how the
    // polls happened to line up with the writes.
    expect(new Set(finished.map((e) => `${e.unit.service}:${e.unit.region}`)).size).toBe(4);
  });

  it("moves the progress counter one unit at a time", async () => {
    if (!available) return;
    const { jobId } = await seed({
      jobStatus: "succeeded",
      run: { status: "succeeded", units: ["succeeded", "succeeded", "succeeded"] },
    });

    const completed = (await collect(scope, jobId))
      .filter((e) => e.type === "scan.progress")
      .map((e) => e.completed);

    /**
     * The progress bar is driven by this event and not by the unit list, so
     * emitting it once per poll made the bar jump straight to complete whenever
     * several units finished between two polls.
     */
    expect(completed).toEqual([1, 2, 3]);
  });

  it("opens with the plan and closes with the finished run", async () => {
    if (!available) return;
    const { jobId, scanId } = await seed({
      jobStatus: "succeeded",
      run: { status: "succeeded", units: ["succeeded", "succeeded"] },
    });

    const events = await collect(scope, jobId);

    expect(typesOf(events)[0]).toBe("scan.started");
    expect(typesOf(events).at(-1)).toBe("scan.finished");

    const started = events.find((e) => e.type === "scan.started")!;
    // The full unit list up front, so a rejoining page renders correctly before
    // a single unit event arrives.
    expect(started.units).toHaveLength(2);
    expect(started.accountId).toBe(ACCOUNT);
    expect(started.regions).toEqual(["us-east-1"]);

    const finished = events.find((e) => e.type === "scan.finished")!;
    expect(finished.scanId).toBe(scanId);
    expect(finished.run.status).toBe("succeeded");
  });

  it("says a job is queued before any worker has taken it", async () => {
    if (!available) return;
    const { jobId } = await seed({ jobStatus: "queued" });

    const events: ScanEvent[] = [];
    for await (const event of streamScanEvents(scope, jobId, { pollMs: 1 })) {
      events.push(event);
      // Terminal never arrives for a queued job, so this stops on its own -
      // the generator is left for the caller to close, as the controller does
      // when the client disconnects.
      break;
    }

    // Without this the UI shows an idle progress bar, which is
    // indistinguishable from the scan having silently failed to start.
    expect(events[0]).toMatchObject({ type: "scan.queued" });
  });

  it("reports a failure that happened before there was a scan to report on", async () => {
    if (!available) return;
    // Assuming the role failed, so there is no run row and the job's error is
    // the only account of it there is.
    const { jobId } = await seed({
      jobStatus: "failed",
      jobError: "The role could not be assumed: AccessDenied",
    });

    const events = await collect(scope, jobId);

    expect(typesOf(events)).toEqual(["scan.failed"]);
    expect(events[0]).toMatchObject({
      type: "scan.failed",
      error: "The role could not be assumed: AccessDenied",
      // Correlated by job id, because there is no scan id to use.
      scanId: jobId,
    });
  });

  it("reports a failed scan as failed even though a run row exists", async () => {
    if (!available) return;
    const { jobId } = await seed({
      jobStatus: "failed",
      jobError: "every region failed",
      run: { status: "failed", units: ["failed", "failed"] },
    });

    const events = await collect(scope, jobId);

    // `scan.finished` carries a run the UI treats as the new current state, so
    // a failed scan must never arrive as one.
    expect(typesOf(events)).not.toContain("scan.finished");
    expect(typesOf(events).at(-1)).toBe("scan.failed");
  });

  it("reports a partial scan as finished, because it has results worth keeping", async () => {
    if (!available) return;
    const { jobId } = await seed({
      jobStatus: "partial",
      run: { status: "partial", units: ["succeeded", "failed"] },
    });

    const events = await collect(scope, jobId);

    // The design commitment the scanner is built on: a scan does not fail, it
    // reports which part is missing. A partial scan's resources are real.
    expect(typesOf(events).at(-1)).toBe("scan.finished");
  });

  it("says a cancelled job was cancelled rather than that it failed", async () => {
    if (!available) return;
    const { jobId } = await seed({ jobStatus: "cancelled" });

    const events = await collect(scope, jobId);
    expect(events.at(-1)).toMatchObject({
      type: "scan.failed",
      error: expect.stringContaining("cancelled"),
    });
  });

  it("tells another tenant nothing at all", async () => {
    if (!available) return;
    const { jobId } = await seed({
      jobStatus: "succeeded",
      run: { status: "succeeded", units: ["succeeded"] },
    });

    /**
     * Not an error and not an empty-but-open stream: a job belonging to someone
     * else is indistinguishable from one that does not exist, so the stream
     * simply ends. An error would confirm the id was real.
     */
    expect(await collect(otherScope, jobId)).toEqual([]);
  });

  it("stops watching a job whose worker went silent, without claiming it failed", async () => {
    if (!available) return;
    // `running` with nothing ever progressing: the state a job is left in when
    // its worker dies, before a reclaim notices.
    const { jobId } = await seed({
      jobStatus: "running",
      run: { status: "running", units: ["pending", "pending"] },
    });

    let clock = 0;
    const events = await collect(scope, jobId, {
      idleLimitMs: 50,
      // Advanced by the stream's own polling, so this needs no real waiting.
      now: () => (clock += 30),
    });

    const last = events.at(-1)!;
    expect(last.type).toBe("scan.failed");
    // The wording matters: the scan may well still be running, and telling
    // somebody it failed would be a guess presented as a fact.
    expect(last).toMatchObject({ error: expect.stringContaining("may still be running") });
  });
});
