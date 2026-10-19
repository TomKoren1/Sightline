/**
 * The scan queue.
 *
 * Postgres rather than Redis: transactional with the data it produces, covered
 * by the same backup, one fewer thing to deploy. `SELECT … FOR UPDATE SKIP
 * LOCKED` is the mechanism - the claim is a row lock taken inside the UPDATE,
 * so two workers racing cannot both win and neither waits behind the other.
 *
 * It replaces an in-process `Set`, which was correct for exactly one API
 * process: two replicas would each believe no scan was running and start one,
 * racing on the same snapshot rows. That guarantee now lives in a partial
 * unique index, which concurrency cannot talk its way around.
 *
 * `heartbeat_at` makes a dead worker's job recoverable, bounded by
 * `max_attempts` - a job that kills one worker will kill the next, and
 * unbounded retry turns one poisonous scan into an outage.
 */

import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";

import { db, system, withTenant } from "../db/postgres.js";
import { scanJobs } from "../db/schema.js";
import type { ConnectionId, JobId, ScanId, TenantId } from "../tenancy/ids.js";
import { asConnectionId, asJobId, asTenantId } from "../tenancy/ids.js";
import type { Scope } from "../tenancy/scope.js";
import {
  scanJobs as scanJobsTotal,
  scanJobsReclaimed,
  scanQueueWait,
} from "../observability/metrics.js";

/**
 * The channel workers listen on.
 *
 * `NOTIFY` cannot be parameterised, so this is interpolated into SQL - which
 * makes it the one string here that must never come from input. It is a module
 * constant for that reason, not for tidiness.
 */
export const SCAN_QUEUE_CHANNEL = "sightline_scan_queued";

/** How often a working worker touches `heartbeat_at`. */
export const HEARTBEAT_INTERVAL_MS = 10_000;

/**
 * How long a silent job waits before another worker may take it.
 *
 * Six heartbeats, deliberately generous. The cost of waiting too long is a
 * scan that starts late; the cost of reclaiming too eagerly is two workers
 * scanning one account at once, each believing it owns the job - which is the
 * exact failure the queue exists to prevent. A paused container, a long GC or a
 * slow AWS call must not look like death.
 */
export const STALE_AFTER_MS = HEARTBEAT_INTERVAL_MS * 6;

export type JobStatus = "queued" | "running" | "succeeded" | "partial" | "failed" | "cancelled";

/** Statuses from which a job will never move on its own. */
export const TERMINAL: ReadonlySet<JobStatus> = new Set<JobStatus>([
  "succeeded",
  "partial",
  "failed",
  "cancelled",
]);

export interface ScanJob {
  id: JobId;
  tenantId: TenantId;
  connectionId: ConnectionId;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  scanId: ScanId | null;
  queuedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
}

/**
 * Raised when a connection already has a scan queued or running.
 *
 * A distinct type rather than a message, because the controller answers it with
 * 409 and the job id of the scan already in flight - which is what lets the UI
 * attach to the running scan instead of showing an error for having asked
 * twice.
 */
export class ScanAlreadyQueued extends Error {
  constructor(public readonly existingJobId: JobId | null) {
    super("A scan of this account is already queued or running.");
  }
}

/** Postgres' unique-violation code. */
const UNIQUE_VIOLATION = "23505";

/**
 * Whether this is the index refusing a second active job.
 *
 * The cause chain is walked because Drizzle wraps driver errors: `code` lives
 * on the wrapped `cause`, and the first version read `err.code`, found
 * `undefined`, and let the driver's error reach the caller - a 500 on the
 * entirely normal path of pressing Scan twice.
 *
 * The constraint is named as well as the code, so a column made unique later is
 * not reported to the user as "a scan is already running".
 */
function isDuplicateActiveJob(err: unknown): boolean {
  for (let e: unknown = err; e != null; e = (e as { cause?: unknown }).cause) {
    if (typeof e !== "object") break;
    const candidate = e as { code?: string; constraint?: string };
    if (candidate.code === UNIQUE_VIOLATION) {
      return candidate.constraint === "scan_jobs_one_active_per_connection";
    }
  }
  return false;
}

/**
 * Queue a scan of this connection.
 *
 * The uniqueness of "one active job per connection" is enforced by the index,
 * not by looking first: a check-then-insert has a window between the two, and
 * this is exactly the kind of thing two replicas do simultaneously. So the
 * insert is attempted and a unique violation is translated - the only ordering
 * in which the answer cannot be stale.
 */
export async function enqueueScan(
  scope: Scope,
  requestedBy: string | null = null,
): Promise<ScanJob> {
  return withTenant(scope.tenantId, async () => {
    const id = asJobId(randomUUID());
    try {
      await db.insert(scanJobs).values({
        id,
        tenantId: scope.tenantId,
        connectionId: scope.connectionId,
        status: "queued",
        requestedBy,
      });
    } catch (err) {
      if (isDuplicateActiveJob(err)) throw new ScanAlreadyQueued(await activeJobId(scope));
      throw err;
    }

    await notifyQueued();

    const job = await getJob(scope, id);
    // The row was just inserted in this function, so its absence would mean a
    // tenant mismatch in `getJob` rather than a missing row - worth saying
    // plainly instead of returning a null the caller cannot interpret.
    if (!job) throw new Error("The scan job was created but could not be read back.");
    return job;
  });
}

/**
 * Wake the workers.
 *
 * `pg_notify` rather than `NOTIFY`, because the latter cannot be parameterised
 * and this way the channel name goes through the driver like any other value.
 * A failure here is swallowed: `NOTIFY` is an optimisation over the poll, and a
 * job that is in the table will be picked up either way. Letting it propagate
 * would fail an enqueue that had already succeeded.
 */
async function notifyQueued(): Promise<void> {
  try {
    // `system`, because this is called from the cross-tenant paths too and
    // `pg_notify` reads no rows - there is nothing for a policy to filter.
    await system.execute(sql`SELECT pg_notify(${SCAN_QUEUE_CHANNEL}, '')`);
  } catch {
    // The poll is the fallback, and it is the reason this can be ignored.
  }
}

/** The job currently queued or running for this connection, if any. */
export async function activeJobId(scope: Scope): Promise<JobId | null> {
  return withTenant(scope.tenantId, async () => {
    const [row] = await db
      .select({ id: scanJobs.id })
      .from(scanJobs)
      .where(
        and(
          eq(scanJobs.tenantId, scope.tenantId),
          eq(scanJobs.connectionId, scope.connectionId),
          sql`${scanJobs.status} IN ('queued','running')`,
        ),
      )
      .limit(1);
    return row?.id ? asJobId(row.id) : null;
  });
}

function rowToJob(row: Record<string, unknown>): ScanJob {
  return {
    id: asJobId(row["id"]),
    tenantId: asTenantId(row["tenant_id"]),
    connectionId: asConnectionId(row["connection_id"]),
    status: row["status"] as JobStatus,
    attempts: Number(row["attempts"]),
    maxAttempts: Number(row["max_attempts"]),
    scanId: (row["scan_id"] as ScanId | null) ?? null,
    queuedAt: new Date(row["queued_at"] as string),
    startedAt: row["started_at"] ? new Date(row["started_at"] as string) : null,
    finishedAt: row["finished_at"] ? new Date(row["finished_at"] as string) : null,
    error: (row["error"] as string | null) ?? null,
  };
}

/**
 * Take the oldest queued job, or return null if there is none.
 *
 * Raw SQL: the correctness rests on the `FOR UPDATE SKIP LOCKED` subquery being
 * inside the UPDATE, so selecting a row and claiming it are one statement. A
 * select followed by an update reintroduces the race.
 *
 * Not tenant-scoped, and on `system` for that reason: a worker serves every
 * tenant, so this is one of the few queries allowed to cross the boundary. It
 * returns the tenant id rather than taking one. Through `db` the restricted
 * role would see only its own connection's tenant and poll an empty queue for
 * ever while jobs piled up.
 */
export async function claimNextJob(workerId: string): Promise<ScanJob | null> {
  const { rows } = await system.execute(sql`
    UPDATE scan_jobs
       SET status = 'running',
           locked_by = ${workerId},
           locked_at = now(),
           heartbeat_at = now(),
           started_at = COALESCE(started_at, now()),
           attempts = attempts + 1
     WHERE id = (
             SELECT id
               FROM scan_jobs
              WHERE status = 'queued'
              ORDER BY queued_at
                FOR UPDATE SKIP LOCKED
              LIMIT 1
           )
    RETURNING *
  `);
  const row = rows[0];
  if (!row) return null;

  const job = rowToJob(row);
  /**
   * Enqueue to claim, which is the wait a person actually feels.
   *
   * Observed here rather than in the worker because this is the moment the
   * waiting ends, and because a worker that crashes between claiming and
   * starting would otherwise never report it.
   */
  scanQueueWait.observe((Date.now() - job.queuedAt.getTime()) / 1000);
  return job;
}

/**
 * Say the worker is still alive, and find out whether it still owns the job.
 *
 * The return value is the point. A worker that was paused long enough to look
 * dead has had its job reclaimed, and must stop rather than carry on writing to
 * a scan another worker is now also writing to. So the caller checks this, and
 * a false means abandon the work in progress.
 */
export async function heartbeat(jobId: JobId, workerId: string): Promise<boolean> {
  // `system`: the worker holds a job id, not a tenant. Same for the three
  // below - they are the lifecycle of a claim, and a claim is cross-tenant.
  const { rowCount } = await system.execute(sql`
    UPDATE scan_jobs
       SET heartbeat_at = now()
     WHERE id = ${jobId}
       AND locked_by = ${workerId}
       AND status = 'running'
  `);
  return (rowCount ?? 0) > 0;
}

/** Record which scan run a claimed job produced, so progress can be read. */
export async function attachScanRun(jobId: JobId, scanId: ScanId): Promise<void> {
  await system.update(scanJobs).set({ scanId }).where(eq(scanJobs.id, jobId));
}

/**
 * Finish a job.
 *
 * Takes the worker id and only finishes a job that worker still holds, for the
 * same reason `heartbeat` reports ownership: a reclaimed job belongs to someone
 * else, and the old owner reporting its outcome would overwrite the new
 * attempt's.
 */
export async function finishJob(
  jobId: JobId,
  workerId: string,
  outcome: { status: Exclude<JobStatus, "queued" | "running">; error?: string | null },
): Promise<boolean> {
  scanJobsTotal.inc({ outcome: outcome.status });
  const { rowCount } = await system.execute(sql`
    UPDATE scan_jobs
       SET status = ${outcome.status},
           finished_at = now(),
           error = ${outcome.error ?? null},
           locked_by = NULL,
           heartbeat_at = NULL
     WHERE id = ${jobId}
       AND locked_by = ${workerId}
  `);
  return (rowCount ?? 0) > 0;
}

export interface ReclaimOutcome {
  /** Jobs put back on the queue for another worker. */
  requeued: number;
  /** Jobs that had used their last attempt and are now failed. */
  abandoned: number;
}

/**
 * Put jobs from dead workers back on the queue.
 *
 * Two statements rather than one, because the two outcomes are genuinely
 * different and collapsing them would hide the second. A job with attempts left
 * goes back to `queued`; a job that has used them all is failed with a message
 * that says what happened, because "it stopped and nobody knows why" is the
 * worst thing for an operator to find.
 *
 * Ordered so that the terminal case runs first. The other way round, a job on
 * its last attempt would be requeued and then immediately failed, consuming an
 * attempt nobody made.
 */
export async function reclaimStale(staleAfterMs = STALE_AFTER_MS): Promise<ReclaimOutcome> {
  const cutoff = sql`now() - ${`${Math.floor(staleAfterMs / 1000)} seconds`}::interval`;

  const abandoned = await system.execute(sql`
    UPDATE scan_jobs
       SET status = 'failed',
           finished_at = now(),
           locked_by = NULL,
           heartbeat_at = NULL,
           error = 'The worker running this scan stopped responding, and the scan had no retries left.'
     WHERE status = 'running'
       AND heartbeat_at < ${cutoff}
       AND attempts >= max_attempts
  `);

  const requeued = await system.execute(sql`
    UPDATE scan_jobs
       SET status = 'queued',
           locked_by = NULL,
           locked_at = NULL,
           heartbeat_at = NULL
     WHERE status = 'running'
       AND heartbeat_at < ${cutoff}
       AND attempts < max_attempts
  `);

  if ((requeued.rowCount ?? 0) > 0) await notifyQueued();

  const outcome = { requeued: requeued.rowCount ?? 0, abandoned: abandoned.rowCount ?? 0 };
  // Both, separately: a requeued job is a worker that died, an abandoned one is
  // a job that has now killed `max_attempts` workers.
  if (outcome.requeued) scanJobsReclaimed.inc(outcome.requeued);
  if (outcome.abandoned) scanJobsTotal.inc({ outcome: "abandoned" }, outcome.abandoned);
  return outcome;
}

/** One of this tenant's jobs, or null. Never another tenant's. */
export async function getJob(scope: Scope, jobId: JobId): Promise<ScanJob | null> {
  return withTenant(scope.tenantId, async () => {
    const [row] = await db
      .select()
      .from(scanJobs)
      .where(and(eq(scanJobs.id, jobId), eq(scanJobs.tenantId, scope.tenantId)))
      .limit(1);
    if (!row) return null;
    return {
      id: asJobId(row.id),
      tenantId: asTenantId(row.tenantId),
      connectionId: asConnectionId(row.connectionId),
      status: row.status,
      attempts: row.attempts,
      maxAttempts: row.maxAttempts,
      scanId: (row.scanId as ScanId | null) ?? null,
      queuedAt: row.queuedAt,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      error: row.error,
    };
  });
}

/**
 * Cancel a queued job.
 *
 * Only `queued`. Cancelling a running scan would need the worker to notice and
 * stop, and a "cancelled" job still writing rows is worse than no cancel at
 * all - so this refuses rather than lying about what it did. Returns whether
 * anything was cancelled, so the caller can say which happened.
 */
export async function cancelQueuedJob(scope: Scope, jobId: JobId): Promise<boolean> {
  return withTenant(scope.tenantId, async () => {
    const { rowCount } = await db.execute(sql`
      UPDATE scan_jobs
         SET status = 'cancelled', finished_at = now()
       WHERE id = ${jobId}
         AND tenant_id = ${scope.tenantId}
         AND status = 'queued'
    `);
    return (rowCount ?? 0) > 0;
  });
}
