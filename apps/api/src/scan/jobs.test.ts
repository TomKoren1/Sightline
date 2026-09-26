/**
 * The queue's two concurrency promises, tested against a real Postgres.
 *
 * Both are enforced by the database rather than by application code, so
 * testing them without a database would test nothing: a mock would return
 * whatever it was told to. These run in the integration job, beside the other
 * tests that need the compose stack.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { pool } from "../db/postgres.js";
import {
  activeJob,
  claimNextJob,
  completeJob,
  enqueueScan,
  failJob,
  reapStuckJobs,
} from "./jobs.js";
import type { TenantId } from "../tenancy/tenant.js";

const HAS_INFRA = !process.env["SKIP_INTEGRATION"];

const T1 = "11111111-0000-4000-8000-000000000001" as TenantId;
const T2 = "22222222-0000-4000-8000-000000000002" as TenantId;

/** A minimal scan_runs row, so completeJob has something real to point at. */
async function insertScanRun(tenantId: TenantId): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO scan_runs (id, tenant_id, account_id, status, started_at, regions)
     VALUES (gen_random_uuid(), $1, '123456789012', 'succeeded', now(), ARRAY['us-east-1'])
     RETURNING id`,
    [tenantId],
  );
  return rows[0]!.id;
}

async function ensureTenants() {
  for (const [id, slug] of [
    [T1, "queue-test-1"],
    [T2, "queue-test-2"],
  ]) {
    await pool.query(
      `INSERT INTO tenants (id, slug, display_name) VALUES ($1, $2, $2)
       ON CONFLICT (id) DO NOTHING`,
      [id, slug],
    );
  }
}

describe.runIf(HAS_INFRA)("the scan queue", () => {
  beforeEach(async () => {
    await ensureTenants();
    await pool.query(`DELETE FROM scan_jobs WHERE tenant_id IN ($1,$2)`, [T1, T2]);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM scan_jobs WHERE tenant_id IN ($1,$2)`, [T1, T2]);
    await pool.query(`DELETE FROM scan_runs WHERE tenant_id IN ($1,$2)`, [T1, T2]);
    await pool.query(`DELETE FROM tenants WHERE id IN ($1,$2)`, [T1, T2]);
    await pool.end();
  });

  it("queues a scan", async () => {
    const { job, created } = await enqueueScan(T1);
    expect(created).toBe(true);
    expect(job.status).toBe("queued");
  });

  /**
   * The double-click. Application logic cannot promise this under concurrency;
   * the partial unique index can.
   */
  it("returns the running job rather than starting a second one", async () => {
    const first = await enqueueScan(T1);
    const second = await enqueueScan(T1);
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
  });

  it("holds the line when the requests arrive together", async () => {
    const results = await Promise.all([
      enqueueScan(T1),
      enqueueScan(T1),
      enqueueScan(T1),
      enqueueScan(T1),
    ]);
    const ids = new Set(results.map((r) => r.job.id));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
  });

  /**
   * The constraint itself, inserted around the application check.
   *
   * The tests above go through `enqueueScan`, which reads before it writes -
   * and in a single process those reads and writes interleave politely enough
   * that they pass **even with the index dropped** (checked, by dropping it).
   * So they prove the happy path, not the guarantee. Two API replicas, or two
   * pods, have no such politeness.
   *
   * This one writes directly. It fails if the partial unique index is missing,
   * which is the only way to test that the database - rather than a lucky
   * interleaving - is what enforces one active scan per tenant.
   */
  it("is the database that refuses a second active job, not the code path", async () => {
    await pool.query(
      `INSERT INTO scan_jobs (id, tenant_id, status) VALUES (gen_random_uuid(), $1, 'queued')`,
      [T1],
    );

    await expect(
      pool.query(
        `INSERT INTO scan_jobs (id, tenant_id, status) VALUES (gen_random_uuid(), $1, 'running')`,
        [T1],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  /** ...and that it only applies to *active* jobs. */
  it("allows any number of finished jobs for one tenant", async () => {
    for (let i = 0; i < 3; i++) {
      await pool.query(
        `INSERT INTO scan_jobs (id, tenant_id, status) VALUES (gen_random_uuid(), $1, 'succeeded')`,
        [T1],
      );
    }
    const { rows } = await pool.query(`SELECT count(*) AS n FROM scan_jobs WHERE tenant_id = $1`, [
      T1,
    ]);
    expect(Number(rows[0].n)).toBe(3);
  });

  it("does not make one tenant wait for another", async () => {
    const a = await enqueueScan(T1);
    const b = await enqueueScan(T2);
    expect(b.created).toBe(true);
    expect(b.job.id).not.toBe(a.job.id);
  });

  /** SKIP LOCKED: two workers polling together must not take the same job. */
  it("gives the same job to only one worker", async () => {
    await enqueueScan(T1);
    await enqueueScan(T2);

    const [w1, w2, w3] = await Promise.all([
      claimNextJob("worker-1"),
      claimNextJob("worker-2"),
      claimNextJob("worker-3"),
    ]);

    const claimed = [w1, w2, w3].filter(Boolean);
    expect(claimed).toHaveLength(2);
    expect(new Set(claimed.map((j) => j!.id)).size).toBe(2);
  });

  it("has nothing to claim when the queue is empty", async () => {
    expect(await claimNextJob("worker-1")).toBeNull();
  });

  it("lets a tenant scan again once the previous scan finishes", async () => {
    const first = await enqueueScan(T1);
    // A real scan row: `scan_jobs.scan_id` is a foreign key, so a job cannot
    // claim to have produced a scan that does not exist.
    const scanId = await insertScanRun(T1);
    await completeJob(first.job.id, scanId);
    expect(await activeJob(T1)).toBeNull();

    const second = await enqueueScan(T1);
    expect(second.created).toBe(true);
    expect(second.job.id).not.toBe(first.job.id);
  });

  it("lets a tenant scan again after a failure", async () => {
    const first = await enqueueScan(T1);
    await failJob(first.job.id, "throttled");
    const second = await enqueueScan(T1);
    expect(second.created).toBe(true);
  });

  /**
   * The failure that would otherwise lock a customer out for ever: a worker
   * killed mid-scan leaves `running` behind, and the uniqueness index then
   * refuses every future scan for that tenant.
   */
  it("releases a job whose worker died, instead of locking the tenant out", async () => {
    await enqueueScan(T1);
    await claimNextJob("worker-that-dies");
    expect(await activeJob(T1)).not.toBeNull();

    // Pretend the claim happened long ago.
    await pool.query(
      `UPDATE scan_jobs SET started_at = now() - interval '2 hours' WHERE tenant_id = $1`,
      [T1],
    );
    const reaped = await reapStuckJobs(60 * 60 * 1000);

    expect(reaped).toBeGreaterThanOrEqual(1);
    expect(await activeJob(T1)).toBeNull();
    expect((await enqueueScan(T1)).created).toBe(true);
  });

  it("leaves a healthy running job alone", async () => {
    await enqueueScan(T1);
    await claimNextJob("worker-1");
    expect(await reapStuckJobs(60 * 60 * 1000)).toBe(0);
    expect(await activeJob(T1)).not.toBeNull();
  });
});
