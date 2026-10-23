/**
 * The loop that drains the scan queue.
 *
 * Claim a job, run it, heartbeat while it runs, record the outcome, repeat.
 * Not racing lives in `queue.ts`; what a scan does lives in `runScanJob.ts`.
 *
 * Wakes on `LISTEN` *and* a poll, not either: `NOTIFY` only reaches sessions
 * listening at the moment it fires, so a job enqueued while this worker was
 * starting or busy would otherwise sit in the table. The listener takes its own
 * client - a pooled connection held for the process's lifetime is a leak.
 *
 * Hosted runs it in its own deployment, so a scan that exhausts memory takes
 * down a worker rather than the API; self-hosted runs it in the API process.
 */

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import pg from "pg";

import { cfg } from "../config.js";
import { asScanId } from "../tenancy/ids.js";
import type { Scope } from "../tenancy/scope.js";
import {
  attachScanRun,
  claimNextJob,
  finishJob,
  heartbeat,
  reclaimStale,
  HEARTBEAT_INTERVAL_MS,
  SCAN_QUEUE_CHANNEL,
  type ScanJob,
} from "./queue.js";
import { withTenant } from "../db/postgres.js";
import { scanningEnabled } from "../tenancy/limits.js";
import { runScanJob } from "./runScanJob.js";

/**
 * How often to look for work with nothing having woken us.
 *
 * Also the ceiling on how long a reclaimable job sits after its worker died,
 * since reclaim runs on the same tick.
 */
const POLL_INTERVAL_MS = 5_000;

export interface WorkerLogger {
  info: (fields: Record<string, unknown>, message: string) => void;
  error: (fields: Record<string, unknown>, message: string) => void;
}

/** Discards everything. The default, so a worker in a test is quiet. */
const noop = (): void => undefined;
const silent: WorkerLogger = { info: noop, error: noop };

export interface WorkerOptions {
  /**
   * How many scans this worker runs at once.
   *
   * One by default, and the default is the point: a scan holds an account's
   * whole inventory in memory while it is analysed, so concurrency here
   * multiplies this process's peak memory. Raising it is a
   * decision about the machine, which is why it is configuration rather than a
   * number chosen here.
   */
  concurrency?: number;
  pollIntervalMs?: number;
  log?: WorkerLogger;
}

/**
 * A worker, startable and stoppable.
 *
 * A class rather than a function because stopping has to be ordered: no new
 * claims, then wait for the scans already running, then drop the listener. A
 * worker killed between claiming a job and finishing it leaves a row that only
 * `reclaimStale` can recover, which costs a scan several minutes - so a clean
 * shutdown is worth the small amount of state this holds.
 */
export class ScanWorker {
  /** Identifies this process in `scan_jobs.locked_by`. */
  readonly id = `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;

  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly log: WorkerLogger;

  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private listener: pg.Client | null = null;
  /** In-flight scans, so shutdown can wait for them. */
  private readonly inFlight = new Set<Promise<void>>();
  /** Set while a drain is in progress, so ticks do not pile up on each other. */
  private draining = false;

  constructor(options: WorkerOptions = {}) {
    this.concurrency = Math.max(1, options.concurrency ?? cfg.SCAN_WORKER_CONCURRENCY);
    this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.log = options.log ?? silent;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.log.info({ worker: this.id, concurrency: this.concurrency }, "scan worker started");

    await this.listen();
    this.timer = setInterval(() => void this.tick(), this.pollIntervalMs);
    // `unref` so a worker embedded in the API process does not keep Node alive
    // on its own after the server has closed.
    this.timer.unref();
    void this.tick();
  }

  /**
   * Stop claiming, then wait for what is already running.
   *
   * The order matters: dropping the listener first would leave a tick able to
   * claim a job the process is about to stop being able to finish.
   */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;

    await Promise.allSettled([...this.inFlight]);

    if (this.listener) {
      const listener = this.listener;
      this.listener = null;
      await listener.end().catch(() => {
        // Shutting down; a listener that will not close cleanly is not worth
        // failing the shutdown over.
      });
    }
  }

  /**
   * Open the `LISTEN` connection.
   *
   * Failing to listen is not fatal - the poll still drains the queue, just
   * less promptly - so this logs and carries on. A worker that refused to start
   * because `NOTIFY` was unavailable would be refusing to work over an
   * optimisation.
   */
  private async listen(): Promise<void> {
    try {
      const client = new pg.Client({ connectionString: cfg.DATABASE_URL });
      await client.connect();
      client.on("notification", () => void this.tick());
      client.on("error", (err) => {
        this.log.error({ err, worker: this.id }, "scan queue listener failed; polling continues");
        this.listener = null;
      });
      await client.query(`LISTEN ${SCAN_QUEUE_CHANNEL}`);
      this.listener = client;
    } catch (err) {
      this.log.error({ err, worker: this.id }, "could not listen for scan jobs; polling only");
    }
  }

  /** One pass: recover dead workers' jobs, then take what capacity allows. */
  private async tick(): Promise<void> {
    if (!this.running || this.draining) return;

    /**
     * The other end of the kill switch.
     *
     * Checked here as well as at the enqueue, because either alone leaves a
     * surprise: refusing only at the API lets an existing backlog keep running,
     * and refusing only here lets tenants queue jobs that never move and look
     * stuck. Reclaim is skipped too - requeueing a job nothing will claim just
     * churns the row.
     */
    if (!scanningEnabled()) return;

    this.draining = true;
    try {
      await this.reclaim();
      while (this.running && this.inFlight.size < this.concurrency) {
        const job = await claimNextJob(this.id);
        if (!job) break;
        this.begin(job);
      }
    } catch (err) {
      this.log.error({ err, worker: this.id }, "scan worker tick failed");
    } finally {
      this.draining = false;
    }
  }

  private async reclaim(): Promise<void> {
    const outcome = await reclaimStale();
    if (outcome.requeued || outcome.abandoned) {
      this.log.info({ ...outcome, worker: this.id }, "recovered jobs from a stopped worker");
    }
  }

  /** Start a claimed job, tracked so shutdown can wait for it. */
  private begin(job: ScanJob): void {
    const task = this.execute(job).finally(() => this.inFlight.delete(task));
    this.inFlight.add(task);
  }

  private async execute(job: ScanJob): Promise<void> {
    const scope: Scope = { tenantId: job.tenantId, connectionId: job.connectionId };
    this.log.info({ job: job.id, attempt: job.attempts, worker: this.id }, "scan job claimed");

    /**
     * Heartbeat on a timer, and remember what it said.
     *
     * The timer is the only thing touching the row while the scan runs, and its
     * answer is cached so `stillMine` can be checked without another query per
     * unit. It starts true because the claim itself proved ownership.
     */
    let owned = true;
    const beat = setInterval(() => {
      void heartbeat(job.id, this.id)
        .then((stillMine) => {
          owned = stillMine;
          if (!stillMine) {
            this.log.error({ job: job.id, worker: this.id }, "job was reclaimed; abandoning it");
          }
        })
        .catch((err) => {
          // A failed heartbeat is not proof of having lost the job, so
          // ownership is left as it was; if the database is really gone, the
          // scan's own writes will fail too.
          this.log.error({ err, job: job.id, worker: this.id }, "heartbeat failed");
        });
    }, HEARTBEAT_INTERVAL_MS);
    beat.unref();

    try {
      /**
       * One tenant context for the whole job.
       *
       * The data-access functions each open their own when called directly, and
       * `withTenant` reuses an outer one - so wrapping here means a scan holds
       * a single connection with `app.tenant_id` set rather than acquiring and
       * resetting one per statement, of which a scan makes thousands.
       */
      const outcome = await withTenant(job.tenantId, () =>
        runScanJob({
          scope,
          correlationId: job.id,
          // A field read, not a query: the heartbeat timer below is what asks
          // the database, and this is its cached answer.
          stillMine: () => owned,
          onScanRun: (scanId) => attachScanRun(job.id, asScanId(scanId)),
          logError: (err) => this.log.error({ err, job: job.id }, "scan failed"),
        }),
      );

      const recorded = await finishJob(job.id, this.id, {
        status: outcome.status,
        error: outcome.error,
      });
      // A refused write means the job was reclaimed mid-scan and now belongs to
      // another attempt. Worth saying out loud: the work this process just did
      // has been discarded, which is otherwise invisible.
      if (!recorded) {
        this.log.error({ job: job.id, worker: this.id }, "outcome discarded; job was reclaimed");
      }
    } catch (err) {
      // `runScanJob` is written not to throw. If it does, the job must still
      // reach a terminal state rather than being left running until a reclaim.
      this.log.error({ err, job: job.id, worker: this.id }, "scan job threw");
      await finishJob(job.id, this.id, {
        status: "failed",
        error: err instanceof Error ? err.message : "The scan failed unexpectedly.",
      }).catch(() => {
        // Nothing left to try; the heartbeat has stopped, so reclaim handles it.
      });
    } finally {
      clearInterval(beat);
    }
  }
}
