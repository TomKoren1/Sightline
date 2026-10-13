/**
 * Scan reads, and running one.
 *
 * A scan is long-running, so the interesting one streams. `run` reports each
 * `(service, region)` unit as it finishes - which is what lets the UI show real
 * progress and, more importantly, show a failure the moment it happens rather
 * than at the end.
 *
 * The order of the writes at the end is the whole of write-then-flip: persist
 * to Postgres, project into a *new* graph scope, and only then mark the scan
 * projected. Until that last statement the connection still reads its previous
 * graph, so a projection that fails costs nothing and no reader ever sees a
 * half-built one.
 */

import { randomUUID } from "node:crypto";
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { rollUpStatus, type ScanEvent, errorMessage } from "@sightline/shared";

import { CallCounter } from "../aws/clients.js";
import { projectGraph, sweepSupersededScans } from "../db/neo4j.js";
import {
  createScanRun,
  currentScanId,
  diffScans,
  failScanRun,
  getLatestScan,
  getScan,
  listScans,
  markProjected,
  saveScanResult,
} from "../db/repository.js";
import { runScan } from "../scan/runner.js";
import { markScanned, markVerified } from "../tenancy/connections.js";
import { resolveScanTarget } from "../tenancy/scanTarget.js";
import type { ScanId } from "../tenancy/ids.js";
import type { Scope } from "../tenancy/scope.js";
import { ScanStateService } from "./scanState.service.js";

@Injectable()
export class ScansService {
  constructor(@Inject(ScanStateService) private readonly state: ScanStateService) {}

  async list(scope: Scope) {
    return { scans: await listScans(scope, 20) };
  }

  async latest(scope: Scope) {
    // A null scan is not an error: a connection nobody has scanned is a normal
    // first-run state, and the UI renders an empty state from this.
    return {
      scan: await getLatestScan(scope),
      scanning: this.state.isRunning(scope.connectionId),
    };
  }

  async byId(scope: Scope, id: string) {
    const scan = await getScan(scope, id);
    // Tenant-scoped, so a scan belonging to someone else is indistinguishable
    // from one that does not exist. That is the right answer to give.
    if (!scan) throw new NotFoundException({ error: "No such scan" });
    return { scan };
  }

  async diff(scope: Scope, query: { from?: string; to?: string }) {
    let { from, to } = query;
    if (!from || !to) {
      const scans = await listScans(scope, 2);
      if (scans.length < 2) {
        return { diff: null, reason: "Only one scan exists; nothing to compare yet." };
      }
      to ??= scans[0]!.id;
      from ??= scans[1]!.id;
    }
    return { diff: await diffScans(scope, from, to) };
  }

  /**
   * Run a scan, reporting progress through `send`.
   *
   * The caller claims first, so it can answer 409 before writing a byte of the
   * stream.
   */
  async run(
    scope: Scope,
    send: (event: ScanEvent) => void,
    logError: (err: unknown) => void,
  ): Promise<void> {
    // The id used in events before the real row exists. The client only uses it
    // to correlate, and the final event carries the persisted run.
    const streamId = randomUUID();
    let scanId: ScanId | null = null;

    try {
      const target = await resolveScanTarget(scope);
      // Captured before the flip: afterwards `currentScanId` is the new scan,
      // and the outgoing one would be unrecoverable.
      const previousScanId = await currentScanId(scope);
      const counter = new CallCounter();
      const result = await runScan({ target, counter, scanId: streamId, onEvent: send });

      scanId = await createScanRun(scope, result.accountId, result.regions);
      await saveScanResult(scope, scanId, {
        status: rollUpStatus(result.units),
        units: result.units,
        resources: result.resources,
        relationships: result.relationships,
        apiCalls: counter.total(),
      });

      // Into its own scope. Nothing is deleted, and the previous graph stays
      // current until `markProjected` below.
      await projectGraph(
        { tenantId: scope.tenantId, scanId },
        result.resources,
        result.relationships,
      );
      await markProjected(scope, scanId);

      // The scan reaching the account *is* a successful verification, and it
      // pins the account id if this was the first one.
      await markVerified(scope, result.accountId);
      await markScanned(scope);

      await this.sweep(scope, [scanId, ...(previousScanId ? [previousScanId] : [])]);

      const run = await getScan(scope, scanId);
      if (run) send({ type: "scan.finished", scanId, run });
    } catch (err) {
      const message = errorMessage(err);
      logError(err);
      if (scanId) await failScanRun(scope, scanId, message);
      send({ type: "scan.failed", scanId: scanId ?? streamId, error: message });
    } finally {
      this.state.release(scope.connectionId);
    }
  }

  claim(scope: Scope): boolean {
    return this.state.claim(scope.connectionId);
  }

  /**
   * Drop graph scopes nobody reads any more.
   *
   * The previous scan is kept alongside the current one, so a request that
   * resolved the old scan id a moment before the flip still finds its graph
   * rather than an empty one. Failures are swallowed: a scan that succeeded
   * must not be reported as failed because tidying up afterwards did not.
   */
  private async sweep(scope: Scope, keep: string[]): Promise<void> {
    try {
      await sweepSupersededScans(scope.tenantId, keep);
    } catch {
      // Leaves superseded nodes behind; the next scan sweeps them.
    }
  }
}
