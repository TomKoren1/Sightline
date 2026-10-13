/**
 * The scan worker as its own process.
 *
 * What a hosted deployment runs instead of letting the API scan: a scan is the
 * one thing here that can consume an unbounded amount of memory - it holds an
 * account's whole inventory and then projects it - and in a multi-tenant
 * deployment it must not be able to take down the API serving everybody else.
 *
 * It serves no HTTP. There is nothing to serve: work arrives through the
 * `scan_jobs` table, and `scan_jobs.heartbeat_at` is how anything else finds
 * out this process is alive. That makes a readiness probe a matter of the
 * database rather than of a port, which is also why this does not open one.
 *
 * Migrations are deliberately not run here. Two processes racing to migrate on
 * boot is the problem a migration Job exists to solve, and a worker that
 * migrated would reintroduce it from the other side.
 */

import pino from "pino";

import { cfg, scanWorkerMode } from "./config.js";
import { closePool } from "./db/postgres.js";
import { closeDriver } from "./db/neo4j.js";
import { assertHostedInvariants } from "./hostedMode.js";
import { ScanWorker } from "./jobs/worker.js";

// The same invariants the API checks, for the same reason: every one of them is
// a configuration mistake that produces a working process with a silently wrong
// security property. A worker with them unchecked would scan with the API's
// guarantees absent.
assertHostedInvariants();

const log = pino({ name: "sightline-worker" });

if (scanWorkerMode() === "off") {
  log.error("SCAN_WORKER is 'off', so this process would claim nothing. Refusing to start idle.");
  process.exit(1);
}

const worker = new ScanWorker({ log });

try {
  await worker.start();
  log.info(
    { deployment: cfg.DEPLOYMENT_MODE, concurrency: cfg.SCAN_WORKER_CONCURRENCY },
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
        await closeDriver();
        await closePool();
        process.exit(0);
      } catch (err) {
        log.error({ err }, "shutdown failed");
        process.exit(1);
      }
    })();
  });
}
