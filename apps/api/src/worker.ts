/**
 * The scan worker as its own process.
 *
 * What a hosted deployment runs instead of letting the API scan: a scan is the
 * one thing here that can consume an unbounded amount of memory - it holds an
 * account's whole inventory and then projects it - and in a multi-tenant
 * deployment it must not be able to take down the API serving everybody else.
 *
 * It serves no application HTTP: work arrives through the `scan_jobs` table,
 * and `scan_jobs.heartbeat_at` is how anything else finds out this process is
 * alive - so liveness is a matter of the database rather than of a port. The
 * one port it does open is the metrics port, which exists because this is the
 * process that holds an inventory in memory and the one that gets OOMKilled,
 * and scraping is the only way to see that coming.
 *
 * Migrations are deliberately not run here. Two processes racing to migrate on
 * boot is the problem a migration Job exists to solve, and a worker that
 * migrated would reintroduce it from the other side.
 */

import pino from "pino";

import { cfg, scanWorkerMode } from "./config.js";
import { assertSchemaCurrent, closePool } from "./db/postgres.js";
import { assertHostedInvariants } from "./hostedMode.js";
import { ScanWorker } from "./jobs/worker.js";
import { loggerOptions } from "./observability/logging.js";
import { recordBuild, startMetricsServer } from "./observability/metrics.js";
import { startSnapshotLoop } from "./observability/snapshot.js";
import { VERSION } from "./version.js";
import { startTracing, stopTracing } from "./observability/tracing.js";
import { watchCertificate } from "./aws/certificateWatch.js";

// The same invariants the API checks, for the same reason: every one of them is
// a configuration mistake that produces a working process with a silently wrong
// security property. A worker with them unchecked would scan with the API's
// guarantees absent.
assertHostedInvariants();

// The same redaction the API uses. A second configuration would be a second
// thing to forget, and this process is the one that holds assumed AWS
// credentials and the ExternalIds it assumed them with.
const log = pino({ name: "sightline-worker", ...loggerOptions() });

if (scanWorkerMode() === "off") {
  log.error("SCAN_WORKER is 'off', so this process would claim nothing. Refusing to start idle.");
  process.exit(1);
}

await startTracing("sightline-worker", VERSION);
const worker = new ScanWorker({ log });

try {
  /**
   * Checked, never applied.
   *
   * Two processes racing to migrate on boot is the problem the migrate Job
   * exists to solve, and a worker that migrated would reintroduce it from the
   * other side. But a worker claiming jobs against a schema that is behind
   * would fail every scan with a column error, so it refuses rather than
   * starting - the same answer the API gives.
   */
  await assertSchemaCurrent();
  await worker.start();
  watchCertificate(log);
  if (cfg.METRICS_PORT > 0) {
    startMetricsServer(cfg.METRICS_PORT);
    recordBuild(VERSION);
    // The process that owns background work owns the gauges that need a query
    // to answer. Exactly one process runs this, whichever mode is in force.
    startSnapshotLoop(log);
  }
  log.info(
    {
      deployment: cfg.DEPLOYMENT_MODE,
      concurrency: cfg.SCAN_WORKER_CONCURRENCY,
      metricsPort: cfg.METRICS_PORT || "off",
    },
    "worker ready",
  );
} catch (err) {
  log.error({ err }, "the worker could not start");
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  // Sync handler with the async work launched inside it, matching `server.ts`:
  // `process.on` expects a void return, and an `async` handler turns a failed
  // close into an unhandled rejection that never reaches `process.exit`.
  process.on(signal, () => {
    log.info(`${signal} received, finishing in-flight scans before exiting`);
    void (async () => {
      try {
        await worker.stop();
        await stopTracing();
        await closePool();
        process.exit(0);
      } catch (err) {
        log.error({ err }, "shutdown failed");
        process.exit(1);
      }
    })();
  });
}
