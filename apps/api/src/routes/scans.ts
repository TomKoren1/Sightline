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

/**
 * Whether a scan is in flight.
 *
 * Single-tenant, so a module-level flag is honest and sufficient. Multi-tenant
 * would key this by account and move it somewhere shared - noted in the README
 * rather than pretended at here.
 */
let scanInProgress = false;

export function registerScanRoutes(app: FastifyInstance): void {
  app.get("/api/scans", async (req) => ({ scans: await listScans(tenantOf(req), 20) }));

  app.get("/api/scans/latest", async (req, reply) => {
    const scan = await getLatestScan(tenantOf(req));
    if (!scan) {
      // Not an error: an account that has never been scanned is a normal
      // first-run state, and the UI renders an empty state from this.
      return reply.send({ scan: null, scanning: scanInProgress });
    }
    return reply.send({ scan, scanning: scanInProgress });
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
  app.post("/api/scans", async (req, reply) => {
    const tenantId = tenantOf(req);
    if (scanInProgress) {
      return reply.code(409).send({ error: "A scan is already running" });
    }
    scanInProgress = true;

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

    try {
      const result = await runScan({ scanId: streamId, onEvent: send });

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

      const run = await getScan(tenantId, scanId);
      if (run) send({ type: "scan.finished", scanId, run });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      req.log.error({ err }, "scan failed");
      if (scanId) await failScanRun(tenantId, scanId, message);
      send({ type: "scan.failed", scanId: scanId ?? streamId, error: message });
    } finally {
      scanInProgress = false;
      reply.raw.end();
    }
  });
}
