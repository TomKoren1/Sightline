/** HTTP server: builds the app, migrates, listens. */

import { buildApp } from "./app.js";
import { cfg, migrateOnBoot, scanWorkerMode } from "./config.js";
import { assertSchemaCurrent, migrate, closePool } from "./db/postgres.js";
import { closeDriver } from "./db/neo4j.js";
import { assertHostedInvariants } from "./hostedMode.js";
import { ScanWorker } from "./jobs/worker.js";
import { ensureLocalTenant } from "./tenancy/local.js";
import { pruneExpiredSessions } from "./auth/session.js";
import { recordBuild, startMetricsServer } from "./observability/metrics.js";
import { startSnapshotLoop } from "./observability/snapshot.js";
import { VERSION } from "./version.js";

/**
 * Before anything else, and before the app is even built.
 *
 * Every rule it checks is a configuration mistake that produces a *working*
 * system with a silently wrong security property, so this must not be reachable
 * only after a request has arrived. Throwing here means the pod never becomes
 * ready, which is what a cluster should see.
 */
assertHostedInvariants();

const app = await buildApp();
// Fastify's logger, reached through the adapter: Nest's own logger is kept to
// errors so the two do not report every request in two formats.
const log = app.getHttpAdapter().getInstance().log;

/**
 * Built unconditionally, started conditionally.
 *
 * So that the shutdown handler below can always call `stop()` without knowing
 * whether it was ever started - a worker that was never started has nothing in
 * flight and stops instantly.
 */
const worker = new ScanWorker({ log });

try {
  /**
   * Migrate, or refuse to start against a schema that is behind.
   *
   * A clone is one process, so migrating on boot is simply convenient. Hosted
   * runs two replicas, which would race to apply the same migration, so there
   * a Job does it and this only checks - and a pod that started before the Job
   * finished fails its readiness probe instead of serving requests against an
   * older schema, where a table added for row-level security would silently not
   * be there.
   */
  if (migrateOnBoot()) {
    await migrate();
  } else {
    await assertSchemaCurrent();
  }
  // A clone is one tenant with two connections. No-op in hosted mode, where
  // tenants arrive by signing up.
  await ensureLocalTenant();
  /**
   * Expired sessions are already refused by `readSession`, so this is
   * housekeeping rather than a control - but an exported function nothing calls
   * is how a check ends up enforced by its own tests and nothing else, which
   * this project has done before. On boot is enough until the job queue exists
   * to run it on a schedule.
   */
  log.info(`pruned ${await pruneExpiredSessions()} expired session(s)`);

  /**
   * The scan worker, in this process or not at all.
   *
   * `embedded` is the self-hosted default: one container, and `npm run dev`
   * scans without anything else being started. Hosted defaults to `separate`,
   * where `apps/api/src/worker.ts` is its own deployment and this process runs
   * no worker - so a scan that exhausts memory takes down a worker rather than
   * the API serving everybody else.
   */
  const mode = scanWorkerMode();
  if (mode === "embedded") {
    await worker.start();
    // This process is the worker, so it owns the state gauges as well.
    if (cfg.METRICS_PORT > 0) startSnapshotLoop(log);
  } else {
    log.info(`scan worker: ${mode} (this process will not run scans)`);
  }

  /**
   * Metrics on their own port, after the app is built so the registry is
   * populated. `0` turns it off, which is what tests and a clone that does not
   * care about Prometheus want.
   */
  if (cfg.METRICS_PORT > 0) {
    startMetricsServer(cfg.METRICS_PORT);
    recordBuild(VERSION);
    log.info(`metrics on :${cfg.METRICS_PORT}/metrics`);
  }

  await app.listen(cfg.BACKEND_PORT, cfg.BACKEND_HOST);
  log.info(`deployment: ${cfg.DEPLOYMENT_MODE}, AWS mode: ${cfg.AWS_MODE}`);
} catch (err) {
  log.error(err);
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  // Sync handler, async work launched inside it: `process.on` expects a void
  // return, so an `async` handler turned a failed close into an unhandled
  // rejection that never reached `process.exit` - the process hung.
  process.on(signal, () => {
    log.info(`${signal} received, shutting down`);
    void (async () => {
      try {
        // The worker first, and before the pool it writes through: it stops
        // claiming, then waits for the scans already in flight. Closing the
        // pool underneath a running scan would fail it for no reason other
        // than the process having been asked to stop.
        await worker.stop();
        await app.close();
        await closeDriver();
        await closePool();
        process.exit(0);
      } catch (err) {
        log.error(err);
        process.exit(1);
      }
    })();
  });
}
