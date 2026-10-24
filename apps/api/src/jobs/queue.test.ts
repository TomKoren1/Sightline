/**
 * The queue, exercised against a real Postgres.
 *
 * Mocking it would test nothing: every property worth having belongs to
 * Postgres' concurrency control, and a fake would agree with whatever the code
 * believes. The three that matter are the held-row skip, the double enqueue
 * (the partial unique index, not a check-then-insert), and bounded reclaim.
 *
 * The first was rewritten after measuring it: two claimers racing for one job
 * reads like a concurrency test and is a coin toss - a naive `SELECT` then
 * `UPDATE` passes it. Holding the row in an uncommitted transaction tests
 * `SKIP LOCKED` itself and cannot be lucky. Requires Postgres.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

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
import { pool, system } from "../db/postgres.js";
import { connections, scanJobs, tenants } from "../db/schema.js";
import { asConnectionId, asTenantId } from "../core/ids.js";
import type { Scope } from "../core/scope.js";
import { lockQueueForTest } from "./queueTestLock.js";
import {
  cancelQueuedJob,
  claimNextJob,
  enqueueScan,
  finishJob,
  getJob,
  heartbeat,
  reclaimStale,
  ScanAlreadyQueued,
  STALE_AFTER_MS,
} from "./queue.js";

/**
 * Read at module level, as the other integration suites do, so it is captured
 * before any test rewrites `process.env` - and gated on SKIP_INTEGRATION alone.
 * An earlier version also required `DATABASE_URL` to be unset, which inverted
 * the whole file whenever CI's conditions were reproduced locally with a
 * deliberately dead URL: the suite ran and failed for having no database,
 * which is exactly what the flag exists to prevent.
 */
const HAS_INFRA = !process.env["SKIP_INTEGRATION"];

const tenantId = asTenantId(randomUUID());
const otherTenantId = asTenantId(randomUUID());

/** Several connections, so "one active per connection" can be told apart from
 * "one active overall" - a distinction a single connection cannot show. */
const scopes: Scope[] = Array.from({ length: 3 }, () => ({
  tenantId,
  connectionId: asConnectionId(randomUUID()),
}));
const otherScope: Scope = {
  tenantId: otherTenantId,
  connectionId: asConnectionId(randomUUID()),
};

let available = false;
let releaseLock: (() => Promise<void>) | null = null;

beforeAll(async () => {
  try {
    await system.execute("SELECT 1");
  } catch {
    return;
  }
  // Exclusive use of the queue: claiming crosses tenants by design, so this
  // file and `progress.test.ts` cannot run at the same time. See queueTestLock.
  releaseLock = await lockQueueForTest();
  available = true;

  for (const [id, name] of [
    [tenantId, "queue.test"],
    [otherTenantId, "queue.test.other"],
  ] as const) {
    await system.insert(tenants).values({ id, name });
  }
  for (const scope of [...scopes, otherScope]) {
    await system.insert(connections).values({
      id: scope.connectionId,
      tenantId: scope.tenantId,
      kind: "demo",
      label: "queue.test",
      externalIdSource: "demo",
    });
  }
});

afterAll(async () => {
  if (available) {
    // Tenants cascade to connections and jobs.
    for (const id of [tenantId, otherTenantId]) {
      await system.delete(tenants).where(eq(tenants.id, id));
    }
  }
  await releaseLock?.();
});

/** Clear the queue between tests, so each starts from a known state. */
async function drain(): Promise<void> {
  await system.execute(sql`DELETE FROM scan_jobs`);
}

/** Pretend the worker holding this job stopped responding. */
async function silenceHeartbeat(jobId: string): Promise<void> {
  await system.execute(sql`
    UPDATE scan_jobs
       SET heartbeat_at = now() - ${`${Math.floor(STALE_AFTER_MS / 1000) + 60} seconds`}::interval
     WHERE id = ${jobId}
  `);
}

describe.runIf(HAS_INFRA)("the scan queue", () => {
  it("has a database to talk to", () => {
    // Without this the whole file passes vacuously when Postgres is absent,
    // which is how a queue test ends up guarding nothing in CI.
    expect(available, "Postgres is not reachable, so none of this was checked").toBe(true);
  });

  /**
   * The deterministic one, and the control for `SKIP LOCKED` specifically.
   *
   * Racing two claimers and hoping they collide is not a test, it is a
   * coin toss - measured, not assumed: a deliberately naive `SELECT` then
   * `UPDATE` implementation **passes** a two-claimer race, because the two
   * statements do not reliably interleave. Holding the row in an uncommitted
   * transaction removes the timing from the question entirely. `SKIP LOCKED`
   * returns nothing; a plain `FOR UPDATE` blocks until this test's own
   * transaction ends, so the wrong implementation fails by deadline rather
   * than by luck.
   */
  it("skips a row another transaction is holding rather than queueing behind it", async () => {
    if (!available) return;
    await drain();
    const job = await enqueueScan(scopes[0]!);

    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM scan_jobs WHERE id = $1 FOR UPDATE", [job.id]);

      expect(await claimNextJob("worker-a")).toBeNull();
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  });

  it("claims the skipped row once the holding transaction lets go", async () => {
    if (!available) return;
    await drain();
    const job = await enqueueScan(scopes[0]!);

    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM scan_jobs WHERE id = $1 FOR UPDATE", [job.id]);
      await claimNextJob("worker-a");
      await holder.query("ROLLBACK");
    } finally {
      holder.release();
    }

    // Skipping must be temporary. If a locked row were dropped from the
    // queue rather than passed over, a scan would be lost silently - which is
    // worse than one that waits.
    expect((await claimNextJob("worker-a"))?.id).toBe(job.id);
  });

  it("hands a job to exactly one of two workers racing for it", async () => {
    if (!available) return;
    await drain();
    await enqueueScan(scopes[0]!);

    // Both issued before either is awaited, so they are at least in flight
    // together. Weaker than the two tests above and kept for the property
    // rather than the mechanism: whatever the interleaving, one winner.
    const [a, b] = await Promise.all([claimNextJob("worker-a"), claimNextJob("worker-b")]);

    const winners = [a, b].filter((job) => job !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.status).toBe("running");
    expect(winners[0]!.attempts).toBe(1);
  });

  it("gives three workers three different jobs", async () => {
    if (!available) return;
    await drain();
    for (const scope of scopes) await enqueueScan(scope);

    const claimed = await Promise.all([
      claimNextJob("worker-a"),
      claimNextJob("worker-b"),
      claimNextJob("worker-c"),
    ]);

    /**
     * This one does catch the naive implementation, and did: three claimers
     * each picking "the oldest queued row" in a separate statement all pick
     * the *same* row, so the set of ids collapses to one.
     */
    const ids = claimed.map((job) => job?.id);
    expect(ids.filter(Boolean)).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });

  it("refuses a second scan of a connection that already has one", async () => {
    if (!available) return;
    await drain();
    const first = await enqueueScan(scopes[0]!);

    await expect(enqueueScan(scopes[0]!)).rejects.toThrow(ScanAlreadyQueued);

    // And it names the job already in flight, which is what lets the UI
    // attach to it instead of reporting an error for asking twice.
    await expect(enqueueScan(scopes[0]!)).rejects.toMatchObject({
      existingJobId: first.id,
    });
  });

  it("refuses while the first is running, not only while it is queued", async () => {
    if (!available) return;
    await drain();
    await enqueueScan(scopes[0]!);
    await claimNextJob("worker-a");

    // The window this closes: a check written against `status = 'queued'`
    // would allow a second scan the moment the first was claimed.
    await expect(enqueueScan(scopes[0]!)).rejects.toThrow(ScanAlreadyQueued);
  });

  it("allows a second scan once the first has finished", async () => {
    if (!available) return;
    await drain();
    await enqueueScan(scopes[0]!);
    const claimed = await claimNextJob("worker-a");
    await finishJob(claimed!.id, "worker-a", { status: "succeeded" });

    // The index is partial precisely so that history accumulates without
    // blocking the next scan.
    const next = await enqueueScan(scopes[0]!);
    expect(next.status).toBe("queued");
  });

  it("does not let one connection's scan block another's", async () => {
    if (!available) return;
    await drain();
    await enqueueScan(scopes[0]!);
    const second = await enqueueScan(scopes[1]!);
    expect(second.status).toBe("queued");
  });

  it("serves a tenant with nothing running before one already being served", async () => {
    if (!available) return;
    await drain();
    await enqueueScan(scopes[0]!);
    await enqueueScan(scopes[1]!);
    const theirs = await enqueueScan(otherScope);
    await system.execute(
      sql`UPDATE scan_jobs SET queued_at = now() + interval '1 minute' WHERE id = ${theirs.id}`,
    );

    // The first tenant's oldest job goes first, then the other tenant - queued
    // last - is served before the first tenant's second job.
    const first = await claimNextJob("worker-a");
    expect(first?.tenantId).toBe(tenantId);
    const second = await claimNextJob("worker-b");
    expect(second?.id).toBe(theirs.id);
  });

  it("claims the oldest job first", async () => {
    if (!available) return;
    await drain();
    const first = await enqueueScan(scopes[0]!);
    // `queued_at` defaults to now(), and two inserts in the same statement
    // timestamp would tie; nudging the first one back makes the order real
    // rather than incidental.
    await system.execute(
      sql`UPDATE scan_jobs SET queued_at = now() - interval '1 minute' WHERE id = ${first.id}`,
    );
    await enqueueScan(scopes[1]!);

    const claimed = await claimNextJob("worker-a");
    expect(claimed?.id).toBe(first.id);
  });

  describe("heartbeats", () => {
    it("reports that the worker still owns the job", async () => {
      if (!available) return;
      await drain();
      await enqueueScan(scopes[0]!);
      const claimed = await claimNextJob("worker-a");

      expect(await heartbeat(claimed!.id, "worker-a")).toBe(true);
    });

    it("tells a worker that lost its job to stop", async () => {
      if (!available) return;
      await drain();
      await enqueueScan(scopes[0]!);
      const claimed = await claimNextJob("worker-a");
      await silenceHeartbeat(claimed!.id);
      await reclaimStale();

      /**
       * The property that stops two workers writing to one scan. A worker
       * paused long enough to look dead has had its job taken; if its
       * heartbeat came back `true` it would carry on projecting into a scope
       * the new attempt is also projecting into.
       */
      expect(await heartbeat(claimed!.id, "worker-a")).toBe(false);
    });

    it("refuses a heartbeat from a worker that never held the job", async () => {
      if (!available) return;
      await drain();
      await enqueueScan(scopes[0]!);
      const claimed = await claimNextJob("worker-a");

      expect(await heartbeat(claimed!.id, "worker-b")).toBe(false);
    });
  });

  describe("reclaiming a dead worker's job", () => {
    it("puts it back on the queue while it has attempts left", async () => {
      if (!available) return;
      await drain();
      await enqueueScan(scopes[0]!);
      const claimed = await claimNextJob("worker-a");
      await silenceHeartbeat(claimed!.id);

      const outcome = await reclaimStale();
      expect(outcome).toEqual({ requeued: 1, abandoned: 0 });

      const next = await claimNextJob("worker-b");
      expect(next?.id).toBe(claimed!.id);
      expect(next?.attempts).toBe(2);
    });

    it("leaves a live worker's job alone", async () => {
      if (!available) return;
      await drain();
      await enqueueScan(scopes[0]!);
      await claimNextJob("worker-a");

      // The heartbeat is fresh, so there is nothing to reclaim. Without this
      // the reclaim could be stealing every running job and the test above
      // would still pass.
      expect(await reclaimStale()).toEqual({ requeued: 0, abandoned: 0 });
    });

    it("fails it rather than retrying for ever once attempts run out", async () => {
      if (!available) return;
      await drain();
      const job = await enqueueScan(scopes[0]!);
      await system.update(scanJobs).set({ maxAttempts: 1 }).where(eq(scanJobs.id, job.id));

      const claimed = await claimNextJob("worker-a");
      await silenceHeartbeat(claimed!.id);

      /**
       * A job that kills its worker will kill the next one too. Bounding the
       * retries is what keeps one poisonous scan from becoming an outage, and
       * the error message has to say what happened - "it stopped and nobody
       * knows why" is the worst thing for an operator to find.
       */
      expect(await reclaimStale()).toEqual({ requeued: 0, abandoned: 1 });

      const after = await getJob(scopes[0]!, job.id);
      expect(after?.status).toBe("failed");
      expect(after?.error).toMatch(/stopped responding/);
      expect(await claimNextJob("worker-b")).toBeNull();
    });
  });

  describe("tenant scoping", () => {
    it("will not read another tenant's job", async () => {
      if (!available) return;
      await drain();
      const mine = await enqueueScan(scopes[0]!);

      // Indistinguishable from a job that does not exist, which is the right
      // answer to give.
      expect(await getJob(otherScope, mine.id)).toBeNull();
    });

    it("will not cancel another tenant's job", async () => {
      if (!available) return;
      await drain();
      const mine = await enqueueScan(scopes[0]!);

      expect(await cancelQueuedJob(otherScope, mine.id)).toBe(false);
      expect((await getJob(scopes[0]!, mine.id))?.status).toBe("queued");
    });
  });

  describe("cancelling", () => {
    it("cancels a queued job", async () => {
      if (!available) return;
      await drain();
      const job = await enqueueScan(scopes[0]!);

      expect(await cancelQueuedJob(scopes[0]!, job.id)).toBe(true);
      expect((await getJob(scopes[0]!, job.id))?.status).toBe("cancelled");
      expect(await claimNextJob("worker-a")).toBeNull();
    });

    it("refuses to cancel a running job rather than lying about it", async () => {
      if (!available) return;
      await drain();
      const job = await enqueueScan(scopes[0]!);
      await claimNextJob("worker-a");

      // Cancelling a running scan needs the worker to notice and stop. A job
      // marked cancelled while still writing rows is worse than no cancel.
      expect(await cancelQueuedJob(scopes[0]!, job.id)).toBe(false);
      expect((await getJob(scopes[0]!, job.id))?.status).toBe("running");
    });
  });

  describe("finishing", () => {
    it("records the outcome and frees the connection", async () => {
      if (!available) return;
      await drain();
      const job = await enqueueScan(scopes[0]!);
      const claimed = await claimNextJob("worker-a");

      expect(
        await finishJob(claimed!.id, "worker-a", {
          status: "partial",
          error: "one region failed",
        }),
      ).toBe(true);

      const after = await getJob(scopes[0]!, job.id);
      expect(after?.status).toBe("partial");
      expect(after?.error).toBe("one region failed");
      expect(after?.finishedAt).toBeInstanceOf(Date);
    });

    it("refuses a worker that no longer holds the job", async () => {
      if (!available) return;
      await drain();
      await enqueueScan(scopes[0]!);
      const claimed = await claimNextJob("worker-a");
      await silenceHeartbeat(claimed!.id);
      await reclaimStale();
      const retried = await claimNextJob("worker-b");

      /**
       * The old owner must not report an outcome. If it could, a worker that
       * came back from a pause would overwrite the new attempt's result -
       * marking a scan succeeded while the scan that actually ran was still
       * going.
       */
      expect(await finishJob(claimed!.id, "worker-a", { status: "failed" })).toBe(false);
      expect((await getJob(scopes[0]!, retried!.id))?.status).toBe("running");
    });
  });
});
