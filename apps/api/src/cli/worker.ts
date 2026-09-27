#!/usr/bin/env tsx
/**
 * The scan worker.
 *
 *   node dist/cli/worker.js
 *
 * Drains `scan_jobs`. A scan of a real account takes minutes, outlives the
 * request that asked for it, and must survive this process being replaced -
 * none of which an HTTP handler can promise.
 *
 * Today the streaming route still runs the scans it starts, because that is
 * what lets it report progress live; it claims its own job so this worker
 * never takes the same row. What this picks up is everything else: a job
 * enqueued by something without a browser attached to it (a scheduled scan,
 * a retry), and any job whose API process died between enqueueing and
 * running - which before this existed simply sat in the queue for ever.
 *
 * Deliberately simple: poll, claim, run, record. No leader election, no
 * distributed lock. `FOR UPDATE SKIP LOCKED` means several of these are safe,
 * and the partial unique index means a tenant still gets one scan at a time.
 */

import { rollUpStatus } from "@daveio/shared";

import { callCounter } from "../aws/clients.js";
import { cfg } from "../config.js";
import { closePool, migrate } from "../db/postgres.js";
import { createScanRun, failScanRun, saveScanResult } from "../db/repository.js";
import { closeDriver, projectGraph } from "../db/neo4j.js";
import { claimNextJob, completeJob, failJob, reapStuckJobs } from "../scan/jobs.js";
import { runScan } from "../scan/runner.js";
import {
  awsApiCalls,
  scanDuration,
  scanUnitsFailed,
  scansFinished,
  scansStarted,
} from "../observability/metrics.js";
import type { TenantId } from "../tenancy/tenant.js";

/** How often to look for work when there was none. */
const IDLE_POLL_MS = 5_000;

/**
 * A scan that has been running longer than this is presumed dead.
 *
 * Generous, because a large estate legitimately takes a while: the cost of
 * reaping too early is a scan killed halfway, while the cost of reaping too
 * late is a tenant waiting. An hour is longer than any scan observed here.
 */
const STUCK_AFTER_MS = 60 * 60 * 1000;

const WORKER_ID = `worker-${process.env["HOSTNAME"] ?? process.pid}`;

let running = true;

async function runOne(job: { id: string; tenantId: TenantId }): Promise<void> {
  const startedAt = Date.now();
  let scanId: string | null = null;
  scansStarted.inc();

  try {
    const result = await runScan({ tenantId: job.tenantId, scanId: job.id });
    scanId = await createScanRun(job.tenantId, result.accountId, result.regions);
    const status = rollUpStatus(result.units);

    await saveScanResult(job.tenantId, scanId, {
      status,
      units: result.units,
      resources: result.resources,
      relationships: result.relationships,
      apiCalls: callCounter.total(),
    });
    // Postgres first, deliberately: if the projection fails the scan is still
    // durable and can be re-projected without going back to AWS.
    await projectGraph(job.tenantId, scanId, result.resources, result.relationships);
    await completeJob(job.id, scanId);

    scansFinished.inc({ status });
    awsApiCalls.inc(callCounter.total());
    for (const unit of result.units) {
      if (unit.status === "failed") {
        scanUnitsFailed.inc({ aws_service: unit.service, code: unit.errorCode ?? "unknown" });
      }
    }
    console.log(`${job.id} ${status}: ${result.resources.length} resources`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The run row, if one was created, and the job both have to reach a
    // terminal state - a job left `running` blocks that tenant until the
    // reaper clears it.
    if (scanId) await failScanRun(job.tenantId, scanId, message);
    await failJob(job.id, message);
    scansFinished.inc({ status: "failed" });
    console.error(`${job.id} failed: ${message}`);
  } finally {
    scanDuration.observe((Date.now() - startedAt) / 1000);
  }
}

async function loop(): Promise<void> {
  while (running) {
    const reaped = await reapStuckJobs(STUCK_AFTER_MS).catch(() => 0);
    if (reaped > 0) console.log(`released ${reaped} stuck job(s)`);

    const job = await claimNextJob(WORKER_ID).catch((err: unknown) => {
      // A database blip must not end the worker: Kubernetes restarting it
      // would lose nothing, but a crash loop during a Postgres restart is
      // noise on top of an incident.
      console.error("could not claim a job:", err);
      return null;
    });

    if (!job) {
      await new Promise((resolve) => setTimeout(resolve, IDLE_POLL_MS));
      continue;
    }

    await runOne({ id: job.id, tenantId: job.tenantId });
  }
}

/** Finish the scan in hand before exiting, so a deploy does not orphan one. */
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (!running) process.exit(1);
    console.log(`${signal}: finishing the current scan, then stopping`);
    running = false;
  });
}

await migrate();
console.log(`${WORKER_ID} polling for scans (${cfg.DEPLOYMENT_MODE})`);
await loop();

await closeDriver();
await closePool();
