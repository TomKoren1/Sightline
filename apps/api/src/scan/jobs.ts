/**
 * Scans as queued work.
 *
 * A scan outlives the request that asked for it, takes minutes on a real
 * account, and must survive the pod restarting underneath it. None of that is
 * expressible as an HTTP handler holding an in-memory flag, which is what this
 * replaces: `routes/scans.ts` tracked `scanInProgress` in a module-level
 * boolean, and said so in its own comment.
 *
 * Two properties are enforced by the **database** rather than by this file,
 * because application logic cannot promise either under concurrency:
 *
 *   - **One active scan per tenant.** A partial unique index on
 *     `(tenant_id) WHERE status IN ('queued','running')`. A double-clicked
 *     button, two browser tabs, or two API replicas all lose the race in
 *     Postgres rather than producing two scans of the same account.
 *   - **One worker per job.** `FOR UPDATE SKIP LOCKED` - the standard
 *     Postgres queue claim. Two workers polling at the same moment take
 *     different jobs instead of both taking the first one.
 */

import { randomUUID } from "node:crypto";

import { pool } from "../db/postgres.js";
import type { TenantId } from "../tenancy/tenant.js";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface ScanJob {
  id: string;
  tenantId: TenantId;
  status: JobStatus;
  scanId: string | null;
  attempts: number;
  queuedAt: string;
  startedAt: string | null;
  error: string | null;
}

interface JobRow {
  id: string;
  tenant_id: string;
  status: JobStatus;
  scan_id: string | null;
  attempts: number;
  queued_at: Date;
  started_at: Date | null;
  error: string | null;
}

function toJob(row: JobRow): ScanJob {
  return {
    id: row.id,
    tenantId: row.tenant_id as TenantId,
    status: row.status,
    scanId: row.scan_id,
    attempts: row.attempts,
    queuedAt: row.queued_at.toISOString(),
    startedAt: row.started_at ? row.started_at.toISOString() : null,
    error: row.error,
  };
}

/**
 * Ask for a scan.
 *
 * Returns the existing job when one is already queued or running, rather than
 * failing: from the user's point of view "scan my account" is satisfied by a
 * scan that is already under way, and reporting a conflict would invite them
 * to retry until they got one.
 */
export async function enqueueScan(tenantId: TenantId): Promise<{ job: ScanJob; created: boolean }> {
  const existing = await activeJob(tenantId);
  if (existing) return { job: existing, created: false };

  try {
    const { rows } = await pool.query<JobRow>(
      `INSERT INTO scan_jobs (id, tenant_id, status) VALUES ($1, $2, 'queued') RETURNING *`,
      [randomUUID(), tenantId],
    );
    return { job: toJob(rows[0]!), created: true };
  } catch (err) {
    // Lost the race against another request between the check and the insert.
    // The index is the authority, so re-read rather than surfacing 23505.
    if ((err as { code?: string }).code === "23505") {
      const now = await activeJob(tenantId);
      if (now) return { job: now, created: false };
    }
    throw err;
  }
}

export async function activeJob(tenantId: TenantId): Promise<ScanJob | null> {
  const { rows } = await pool.query<JobRow>(
    `SELECT * FROM scan_jobs
      WHERE tenant_id = $1 AND status IN ('queued','running')
      ORDER BY queued_at LIMIT 1`,
    [tenantId],
  );
  return rows[0] ? toJob(rows[0]) : null;
}

export async function getJob(tenantId: TenantId, jobId: string): Promise<ScanJob | null> {
  const { rows } = await pool.query<JobRow>(
    `SELECT * FROM scan_jobs WHERE id = $1 AND tenant_id = $2`,
    [jobId, tenantId],
  );
  return rows[0] ? toJob(rows[0]) : null;
}

/**
 * Take the next job, or nothing.
 *
 * `SKIP LOCKED` is what makes this safe to run in several workers: a row
 * another transaction has locked is passed over rather than waited for, so two
 * workers never take the same job and neither blocks.
 */
export async function claimNextJob(worker: string): Promise<ScanJob | null> {
  const { rows } = await pool.query<JobRow>(
    `UPDATE scan_jobs
        SET status = 'running', started_at = now(), attempts = attempts + 1, claimed_by = $1
      WHERE id = (
        SELECT id FROM scan_jobs
         WHERE status = 'queued'
         ORDER BY queued_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      RETURNING *`,
    [worker],
  );
  return rows[0] ? toJob(rows[0]) : null;
}

export async function completeJob(jobId: string, scanId: string): Promise<void> {
  await pool.query(
    `UPDATE scan_jobs SET status = 'succeeded', scan_id = $2, finished_at = now() WHERE id = $1`,
    [jobId, scanId],
  );
}

export async function failJob(jobId: string, error: string): Promise<void> {
  await pool.query(
    `UPDATE scan_jobs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`,
    [jobId, error],
  );
}

/**
 * Release jobs whose worker died.
 *
 * A pod killed mid-scan leaves a row marked `running` for ever, and the
 * partial unique index means that tenant can never queue another scan - a
 * single crash would lock one customer out of the product permanently. So
 * stuck jobs are failed rather than left, with a reason that says what
 * happened instead of a generic timeout.
 */
export async function reapStuckJobs(olderThanMs: number): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE scan_jobs
        SET status = 'failed', finished_at = now(),
            error = 'The worker running this scan stopped responding. Nothing was changed in your account; run another scan when ready.'
      WHERE status = 'running'
        AND started_at < now() - ($1::bigint * interval '1 millisecond')`,
    [Math.max(olderThanMs, 1000)],
  );
  return rowCount ?? 0;
}
