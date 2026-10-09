/**
 * Scan reads, and running one.
 *
 * A scan is long-running, so the interesting one streams. `runStreaming` opens
 * a server-sent event stream and reports each `(service, region)` unit as it
 * finishes - which is what lets the UI show real progress and, more
 * importantly, show a failure the moment it happens rather than at the end.
 */

import { randomUUID } from "node:crypto";
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { rollUpStatus, type ScanEvent, errorMessage } from "@sightline/shared";

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
import { ScanStateService } from "./scanState.service.js";

@Injectable()
export class ScansService {
  constructor(@Inject(ScanStateService) private readonly state: ScanStateService) {}

  async list() {
    return { scans: await listScans(20) };
  }

  async latest() {
    // A null scan is not an error: an account that has never been scanned is a
    // normal first-run state, and the UI renders an empty state from this.
    return { scan: await getLatestScan(), scanning: this.state.isRunning };
  }

  async byId(id: string) {
    const scan = await getScan(id);
    if (!scan) throw new NotFoundException({ error: "No such scan" });
    return { scan };
  }

  async diff(query: { from?: string; to?: string }) {
    let { from, to } = query;
    if (!from || !to) {
      const scans = await listScans(2);
      if (scans.length < 2) {
        return { diff: null, reason: "Only one scan exists; nothing to compare yet." };
      }
      to ??= scans[0]!.id;
      from ??= scans[1]!.id;
    }
    return { diff: await diffScans(from, to) };
  }

  /**
   * Run a scan, reporting progress through `send`.
   *
   * Returns false without doing anything if one is already running, so the
   * caller can answer 409 before it has written a single byte of the stream.
   */
  async run(send: (event: ScanEvent) => void, logError: (err: unknown) => void): Promise<void> {
    // The id used in events before the real row exists. The client only uses
    // it to correlate, and the final event carries the persisted run.
    const streamId = randomUUID();
    let scanId: string | null = null;

    try {
      const result = await runScan({ scanId: streamId, onEvent: send });

      scanId = await createScanRun(result.accountId, result.regions);
      const status = rollUpStatus(result.units);

      await saveScanResult(scanId, {
        status,
        units: result.units,
        resources: result.resources,
        relationships: result.relationships,
        apiCalls: callCounter.total(),
      });
      await projectGraph(scanId, result.resources, result.relationships);

      const run = await getScan(scanId);
      if (run) send({ type: "scan.finished", scanId, run });
    } catch (err) {
      const message = errorMessage(err);
      logError(err);
      if (scanId) await failScanRun(scanId, message);
      send({ type: "scan.failed", scanId: scanId ?? streamId, error: message });
    } finally {
      this.state.release();
    }
  }

  claim(): boolean {
    return this.state.claim();
  }
}
