/**
 * The scan queue.
 *
 * Postgres rather than Redis. The queue is then transactional with the data it
 * produces, it is covered by the same backup, and there is one fewer thing to
 * deploy and lose. `SELECT … FOR UPDATE SKIP LOCKED` is the mechanism: the
 * claim is a row lock taken inside the UPDATE, so two workers racing for the
 * same job cannot both get it, and a claimer never waits behind another
 * claimer - it skips to the next unlocked row.
 *
 * What this replaces is `ScanStateService`, an in-process `Set`. That was
 * correct for exactly one API process and silently stops being correct at two:
 * two replicas, or an API and a worker, would each believe no scan of a
 * connection was running and start one, racing on the same snapshot rows and
 * the same graph scope. The guarantee now lives in a partial unique index,
 * which no amount of concurrency can talk its way around.
 *
 * ## Liveness
 *
 * A worker that dies mid-scan leaves a `running` row that nothing will ever
 * finish. `heartbeat_at` is what makes that recoverable: the worker touches it
 * while it works, and `reclaimStale` returns jobs whose heartbeat has stopped.
 * Reclaim is bounded by `max_attempts`, because a job that kills its worker
 * will kill the next one too, and an unbounded retry turns one poisonous scan
 * into an outage.
 */

import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";

import { db } from "../db/postgres.js";
import { scanJobs } from "../db/schema.js";
import type { ConnectionId, JobId, ScanId, TenantId } from "../tenancy/ids.js";
import { asConnectionId, asJobId, asTenantId } from "../tenancy/ids.js";
import type { Scope } from "../tenancy/scope.js";

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
 * The cause chain is walked rather than the error inspected directly, because
 * Drizzle wraps driver errors: the `code` lives on the wrapped `cause`, and a
 * check against the top-level object finds `undefined`. That is not a
 * hypothetical - the first version of this read `err.code`, and the test for a
 * double enqueue failed with the driver's own error reaching the caller. In
 * production that would have been a 500 where the UI expected a 409, on the
 * entirely normal path of someone pressing Scan twice.
 *
 * The constraint is named as well as the code. Any unique violation reaching
 * this `try` is this one today, but a column made unique later would otherwise
 * be reported to the user as "a scan is already running".
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
    await db.execute(sql`SELECT pg_notify(${SCAN_QUEUE_CHANNEL}, '')`);
  } catch {
    // The poll is the fallback, and it is the reason this can be ignored.
  }
}

/** The job currently queued or running for this connection, if any. */
export async function activeJobId(scope: Scope): Promise<JobId | null> {
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
 * Raw SQL, not the query builder: the whole correctness of this rests on the
 * `FOR UPDATE SKIP LOCKED` subquery being inside the UPDATE, so that selecting
 * a row and claiming it are one statement. Expressing it as a select followed
 * by an update would reintroduce precisely the race the clause exists to close.
 *
 * Not scoped to a tenant, and that is not an oversight: a worker serves every
 * tenant, so this is one of the few queries in the codebase that is allowed to
 * cross the boundary. It returns the tenant id rather than taking one, and
 * everything the worker does afterwards is scoped by what it found here.
 */
export async function claimNextJob(workerId: string): Promise<ScanJob | null> {
  const { rows } = await db.execute(sql`
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
  return row ? rowToJob(row) : null;
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
  const { rowCount } = await db.execute(sql`
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
  await db.update(scanJobs).set({ scanId }).where(eq(scanJobs.id, jobId));
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
  const { rowCount } = await db.execute(sql`
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

  const abandoned = await db.execute(sql`
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

  const requeued = await db.execute(sql`
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

  return { requeued: requeued.rowCount ?? 0, abandoned: abandoned.rowCount ?? 0 };
}

/** One of this tenant's jobs, or null. Never another tenant's. */
export async function getJob(scope: Scope, jobId: JobId): Promise<ScanJob | null> {
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
  const { rowCount } = await db.execute(sql`
    UPDATE scan_jobs
       SET status = 'cancelled', finished_at = now()
     WHERE id = ${jobId}
       AND tenant_id = ${scope.tenantId}
       AND status = 'queued'
  `);
  return (rowCount ?? 0) > 0;
}
