/**
 * Scan endpoints.
 *
 * A scan is long-running, so the interesting one streams. `POST /api/scans`
 * opens a server-sent event stream and reports each `(service, region)` unit
 * as it finishes - which is what lets the UI show real progress and, more
 * importantly, show a failure the moment it happens rather than at the end.
 */

import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { rollUpStatus, type ScanEvent } from "@daveio/shared";

import { callCounter } from "../aws/clients.js";
import { projectGraph } from "../db/neo4j.js";
import {
  createScanRun,
  diffScans,
  failScanRun,
  getLatestScan,
  getScan,
  listScans,
  saveScanResult,
} from "../db/repository.js";
import { runScan } from "../scan/runner.js";
import { tenantOf } from "../tenancy/request.js";
import { isHosted } from "../config.js";
import { limitConfig, limits } from "../security/limits.js";
import { getConnection } from "../tenancy/connections.js";
import { getTenant } from "../tenancy/tenants.js";
import {
  awsApiCalls,
  scanDuration,
  scanUnitsFailed,
  scansFinished,
  scansStarted,
} from "../observability/metrics.js";
import { activeJob, claimJob, completeJob, enqueueScan, failJob } from "../scan/jobs.js";

/**
 * Whether a scan is in flight - now a row, not a boolean.
 *
 * This was a module-level flag, which was honest for one tenant and wrong the
 * moment there were two: it is per-process, so two API replicas each believe
 * they are the only one, and it is lost on restart, so a pod that dies mid-scan
 * leaves the flag cleared and the scan orphaned.
 *
 * `scan_jobs` replaces it. One active scan per tenant is enforced by a partial
 * unique index, which holds across replicas and across restarts - see
 * `scan/jobs.ts`.
 */

export function registerScanRoutes(app: FastifyInstance): void {
  app.get("/api/scans", async (req) => ({ scans: await listScans(tenantOf(req), 20) }));

  app.get("/api/scans/latest", async (req, reply) => {
    const tenantId = tenantOf(req);
    // `scanning` now answers "is there an active job for this tenant", which
    // is true whichever replica started it and survives this one restarting.
    const [scan, running] = await Promise.all([getLatestScan(tenantId), activeJob(tenantId)]);
    if (!scan) {
      // Not an error: an account that has never been scanned is a normal
      // first-run state, and the UI renders an empty state from this.
      return reply.send({ scan: null, scanning: running !== null });
    }
    return reply.send({ scan, scanning: running !== null });
  });

  app.get<{ Params: { id: string } }>("/api/scans/:id", async (req, reply) => {
    const scan = await getScan(tenantOf(req), req.params.id);
    if (!scan) return reply.code(404).send({ error: "No such scan" });
    return reply.send({ scan });
  });

  app.get<{ Querystring: { from?: string; to?: string } }>(
    "/api/scans/diff",
    async (req, reply) => {
      const tenantId = tenantOf(req);
      let { from, to } = req.query;
      if (!from || !to) {
        const scans = await listScans(tenantId, 2);
        if (scans.length < 2) {
          return reply.send({
            diff: null,
            reason: "Only one scan exists; nothing to compare yet.",
          });
        }
        to ??= scans[0]!.id;
        from ??= scans[1]!.id;
      }
      return reply.send({ diff: await diffScans(tenantId, from, to) });
    },
  );

  /** Run a scan, streaming progress as server-sent events. */
  app.post("/api/scans", limitConfig(limits.scan), async (req, reply) => {
    const tenantId = tenantOf(req);

    /**
     * Claiming the slot before streaming anything, because the answer to "is a
     * scan already running?" has to come from the database rather than from
     * this process's memory.
     *
     * An existing job is reported as a conflict rather than joined: this
     * endpoint streams the scan it starts, and attaching a second stream to a
     * scan already in flight would need the worker's event bus, which is
     * `docs/HOSTED-PLAN.md` Phase 3's remaining work.
     */
    /**
     * Refuse before claiming a job slot.
     *
     * A hosted tenant who has not connected an account has nothing to scan,
     * and the failure must be this explicit sentence rather than an
     * AssumeRole error thirty seconds later - or, worse, a scan of whatever
     * account the process happened to be configured with.
     */
    if (isHosted()) {
      // A tenant on the demo account has nothing to connect, and telling them
      // to connect one would be advice that does not apply to what they are
      // looking at.
      const tenant = await getTenant(tenantId);
      const connection = tenant?.demoMode ? null : await getConnection(tenantId);
      if (!tenant?.demoMode && (!connection || connection.status === "disconnected")) {
        return reply.code(409).send({
          error: "Connect an AWS account before scanning.",
          code: "NO_CONNECTION",
        });
      }
    }

    const { job, created } = await enqueueScan(tenantId);

    /**
     * Take the job out of the queue before streaming it.
     *
     * This route runs the scan itself, which is what lets it report progress
     * as it happens - so the worker must not also pick it up. Losing the race
     * means another process already started this tenant's scan.
     */
    if (created && !(await claimJob(job.id, `api-${process.pid}`))) {
      return reply.code(409).send({ error: "A scan is already running", jobId: job.id });
    }

    if (!created) {
      return reply
        .code(409)
        .send({ error: "A scan is already running", jobId: job.id, since: job.queuedAt });
    }

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Without this, a reverse proxy will happily buffer the whole stream and
      // deliver it at the end, which defeats the point.
      "X-Accel-Buffering": "no",
    });

    const send = (event: ScanEvent) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    // The id used in events before the real row exists. The client only uses
    // it to correlate, and the final event carries the persisted run.
    const streamId = randomUUID();
    let scanId: string | null = null;
    const startedAt = Date.now();
    scansStarted.inc();

    try {
      const result = await runScan({ tenantId: tenantId, scanId: streamId, onEvent: send });

      scanId = await createScanRun(tenantId, result.accountId, result.regions);
      const status = rollUpStatus(result.units);

      await saveScanResult(tenantId, scanId, {
        status,
        units: result.units,
        resources: result.resources,
        relationships: result.relationships,
        apiCalls: callCounter.total(),
      });
      await projectGraph(tenantId, scanId, result.resources, result.relationships);

      await completeJob(job.id, scanId);

      /**
       * `partial` is counted separately from `succeeded` on purpose: a scan
       * that lost a region still returns 200 and looks healthy in request
       * metrics, which is exactly the state this product exists to be honest
       * about.
       */
      scansFinished.inc({ status });
      scanDuration.observe((Date.now() - startedAt) / 1000);
      awsApiCalls.inc(callCounter.total());
      for (const unit of result.units) {
        if (unit.status === "failed") {
          scanUnitsFailed.inc({ aws_service: unit.service, code: unit.errorCode ?? "unknown" });
        }
      }

      const run = await getScan(tenantId, scanId);
      if (run) send({ type: "scan.finished", scanId, run });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      req.log.error({ err }, "scan failed");
      if (scanId) await failScanRun(tenantId, scanId, message);
      await failJob(job.id, message);
      scansFinished.inc({ status: "failed" });
      scanDuration.observe((Date.now() - startedAt) / 1000);
      send({ type: "scan.failed", scanId: scanId ?? streamId, error: message });
    } finally {
      // The job row is already terminal by here. Nothing to release: a scan
      // that ends without reaching either branch above is exactly the stuck
      // job `reapStuckJobs` exists to clear.
      reply.raw.end();
    }
  });
}
