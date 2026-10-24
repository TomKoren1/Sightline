/**
 * What a claimed job actually does.
 *
 * This is the body of the old `ScansService.run`, with one change that matters:
 * progress is written to Postgres as it happens instead of only being pushed
 * down an open HTTP response. The run row and its units exist while the scan is
 * still going, so the stream can be reconstructed by anything that can read the
 * database - which is what lets a reloaded page rejoin a scan rather than
 * orphaning it, and what lets the scan run in a process that has no connection
 * to the browser at all.
 *
 * The write order at the end is write-then-flip: persist the snapshots, and
 * only then mark the scan projected. Until that statement the connection still
 * reads its previous scan, so no reader ever sees a half-written one.
 */

import {
  rollUpStatus,
  type ScanEvent,
  type ScanStatus,
  type ScanUnit,
  errorMessage,
} from "@sightline/shared";

import { CallCounter } from "../aws/clients.js";
import { cfg } from "../config.js";
import {
  createScanRun,
  failScanRun,
  getScan,
  markProjected,
  pruneScanHistory,
  recordScanUnit,
  refreshSnapshotStatistics,
  saveScanResult,
  startScanUnits,
  STATISTICS_REFRESH_THRESHOLD,
} from "../db/repository.js";
import { syncFindings } from "../db/findings.js";
import { runScan } from "../scan/runner.js";
import { markScanned, markVerified } from "../tenancy/connections.js";
import { resolveScanTarget } from "../tenancy/scanTarget.js";
import type { ScanId } from "../tenancy/ids.js";
import { tooManyResources } from "../tenancy/limits.js";
import type { Scope } from "../tenancy/scope.js";
import {
  scanDuration,
  scanResources,
  scanUnitDuration,
  scanUnitFailures,
} from "../observability/metrics.js";
import { listConnections } from "../tenancy/connections.js";

export interface ScanJobOutcome {
  /** The status to finish the queue row with. */
  status: Extract<ScanStatus, "succeeded" | "partial" | "failed">;
  scanId: ScanId | null;
  error: string | null;
  /**
   * What the scan produced, when it produced anything.
   *
   * Here so the CLI can print its summary without reaching back into the
   * database for numbers this function already had - and, more to the point, so
   * the CLI does not need its own copy of the pipeline to get them.
   */
  summary?: {
    resources: number;
    relationships: number;
    apiCalls: number;
    units: ScanUnit[];
  };
}

export interface RunScanJobOptions {
  scope: Scope;
  /**
   * What events are tagged with until a run row exists.
   *
   * The queue passes the job's id; `npm run scan`, which has no job, passes a
   * fresh one. Both go through this function rather than keeping two copies of
   * write-then-flip - the two had already drifted, with the CLI's copy missing
   * the guard against projecting a scan that read nothing.
   */
  correlationId: string;
  /** Called once the run row exists, so the queue row can point at it. */
  onScanRun?: (scanId: ScanId) => Promise<void> | void;
  /**
   * Whether this process still owns the job.
   *
   * Checked between units rather than only at the start. A worker that was
   * paused long enough to look dead has had its job reclaimed, and must stop
   * instead of continuing to write to a scan the new attempt is also writing
   * to. Returning false aborts; the job is left for whoever owns it now.
   */
  stillMine?: () => boolean | Promise<boolean>;
  /** Progress, for a caller that happens to have somebody listening. */
  onEvent?: (event: ScanEvent) => void;
  logError?: (err: unknown) => void;
}

/** Raised to unwind a scan whose job was taken by another worker. */
class LostTheJob extends Error {
  constructor() {
    super("This scan's job was reclaimed by another worker, so this attempt stopped.");
  }
}

export async function runScanJob(options: RunScanJobOptions): Promise<ScanJobOutcome> {
  const { scope, correlationId, onEvent, onScanRun, stillMine, logError } = options;
  const emit = (event: ScanEvent) => onEvent?.(event);
  let scanId: ScanId | null = null;
  // One clock for the whole attempt, so a failure is timed too - a scan that
  // takes four minutes to fail is a different problem from one that fails fast.
  const startedAt = Date.now();

  try {
    const target = await resolveScanTarget(scope);
    const counter = new CallCounter();

    /**
     * Persist each event as well as forwarding it.
     *
     * Serialised through a promise chain rather than fired and forgotten. The
     * writes are small and the units arrive concurrently, so without this a
     * burst of them would open as many simultaneous statements as there are
     * units - and, worse, two writes for the same unit could land out of
     * order, leaving a finished unit recorded as running.
     */
    let writes: Promise<void> = Promise.resolve();
    const persist = (write: () => Promise<void>): void => {
      writes = writes.then(write).catch((err) => {
        // Progress is a view of the scan, not the scan. Losing a row costs
        // the UI one tick; failing the scan over it would throw away work
        // that succeeded.
        logError?.(err);
      });
    };

    // The tenant's own accounts, so a trust naming one of them reads as that
    // connection rather than as a stranger.
    const knownAccounts = new Map(
      (await listConnections(scope.tenantId))
        .filter((c) => c.accountId && c.id !== scope.connectionId)
        .map((c) => [c.accountId!, c.label] as const),
    );
    const result = await runScan({
      target,
      counter,
      knownAccounts,
      // Correlated by job id until a run row exists, so a failure before that
      // point still arrives against something the client is watching.
      scanId: correlationId,
      onEvent: (event) => {
        emit(event);
        if (event.type === "scan.started") {
          persist(async () => {
            scanId = await createScanRun(scope, event.accountId, event.regions);
            await startScanUnits(scope, scanId, event.units);
            await onScanRun?.(scanId);
          });
        } else if (event.type === "unit.started") {
          persist(async () => {
            if (!scanId) return;
            await recordScanUnit(scope, scanId, {
              service: event.service,
              region: event.region,
              status: "running",
              resourceCount: 0,
              apiCalls: 0,
              durationMs: 0,
              startedAt: new Date().toISOString(),
            });
          });
        } else if (event.type === "unit.finished") {
          const unit = event.unit;
          /**
           * `region` is `null` for global services, and a metric label cannot
           * be null - `global` says the same thing and keeps the series stable.
           * The reason is AWS's own error code, which is a closed set, rather
           * than the message, which is not.
           */
          const where = { service: unit.service, region: unit.region ?? "global" };
          scanUnitDuration.observe(where, unit.durationMs / 1000);
          if (unit.status === "failed") {
            scanUnitFailures.inc({ ...where, reason: unit.errorCode ?? "unknown" });
          }
          persist(async () => {
            if (scanId) await recordScanUnit(scope, scanId, unit);
          });
        }
      },
    });

    // Every queued write has to land before the final state is computed from
    // the same rows, or `saveScanResult` and a late unit write race.
    await writes;

    if (stillMine && !(await stillMine())) throw new LostTheJob();

    // The runner's units are the authority at this point; the incremental rows
    // were a running view of the same thing.
    scanId ??= await createScanRun(scope, result.accountId, result.regions);

    /**
     * `rollUpStatus` answers "running" when no unit reached a terminal state,
     * which after the scan has returned means it did nothing at all.
     *
     * Unreachable today - `iam` and `s3` are global, so there is always at
     * least one unit whatever the region list - but unreachable by accident
     * rather than by construction, and recording it as a success would file an
     * empty inventory as this account's current state. Narrowed explicitly
     * instead of cast, so the one state the job row cannot represent is the one
     * state this has to decide about.
     */
    const rolled = rollUpStatus(result.units);
    if (rolled === "running") {
      const problem =
        "The scan completed without reading anything: no service and region produced a result.";
      await failScanRun(scope, scanId, problem);
      emit({ type: "scan.failed", scanId, error: problem });
      // Returns before the flip. Flipping an empty scan would make one that
      // read nothing into this connection's current graph, which
      // reads to the user as every resource having disappeared.
      return { status: "failed", scanId, error: problem };
    }
    const status = rolled;

    /**
     * Too big to publish.
     *
     * Checked where `saveScanResult` would have run, and before the flip, so
     * the scan is still *recorded* - the counts and the per-unit outcomes are
     * real findings about the account, and throwing them away would hide the
     * very thing the operator needs to see. What is skipped is the flip, so the
     * tenant keeps reading the graph they already had rather than one too
     * large to query or render.
     */
    const size = tooManyResources(result.resources.length);
    if (!size.allowed) {
      // `failed`, not the rolled-up status: the units really did succeed, but
      // the scan did not become anything the tenant can read, and a row saying
      // `succeeded` is how somebody concludes their graph is up to date. Saved
      // as failed from the start rather than corrected afterwards, so there is
      // no moment where it claims otherwise.
      await saveScanResult(scope, scanId, {
        status: "failed",
        units: result.units,
        resources: result.resources,
        relationships: result.relationships,
        apiCalls: counter.total(),
      });
      await failScanRun(scope, scanId, size.reason);
      emit({ type: "scan.failed", scanId, error: size.reason });
      return { status: "failed", scanId, error: size.reason };
    }

    await saveScanResult(scope, scanId, {
      status,
      units: result.units,
      resources: result.resources,
      relationships: result.relationships,
      apiCalls: counter.total(),
    });

    scanResources.observe(result.resources.length);
    if (result.resources.length >= STATISTICS_REFRESH_THRESHOLD) {
      await refreshSnapshotStatistics();
    }
    // Before the flip, so the scan that becomes current already has its
    // findings' history behind it. Only a scan that read everything may
    // resolve what it did not see.
    await syncFindings(scope, scanId, status === "succeeded");
    await markProjected(scope, scanId);

    // The scan reaching the account *is* a successful verification, and it pins
    // the account id if this was the first one.
    await markVerified(scope, result.accountId);
    await markScanned(scope);

    await prune(scope);

    scanDuration.observe({ outcome: status }, (Date.now() - startedAt) / 1000);

    const run = await getScan(scope, scanId);
    if (run) emit({ type: "scan.finished", scanId, run });

    return {
      status,
      scanId,
      error: null,
      summary: {
        resources: result.resources.length,
        relationships: result.relationships.length,
        apiCalls: counter.total(),
        units: result.units,
      },
    };
  } catch (err) {
    const message = errorMessage(err);
    logError?.(err);

    /**
     * A reclaimed job is not a failed scan.
     *
     * Reported as failed, this attempt would overwrite the outcome of the
     * attempt that actually owns the job - and the queue refuses the write
     * anyway, because finishing requires still holding the lock. So the run row
     * is left alone for the new attempt to overwrite.
     */
    if (err instanceof LostTheJob) {
      return { status: "failed", scanId, error: message };
    }

    scanDuration.observe({ outcome: "failed" }, (Date.now() - startedAt) / 1000);
    if (scanId) await failScanRun(scope, scanId, message);
    emit({ type: "scan.failed", scanId: scanId ?? correlationId, error: message });
    return { status: "failed", scanId, error: message };
  }
}

/** Best effort: history left behind is pruned after the next scan. */
async function prune(scope: Scope): Promise<void> {
  try {
    await pruneScanHistory(scope, cfg.SCAN_HISTORY_KEEP);
  } catch {
    // Retention is housekeeping; a scan that succeeded must not report failure.
  }
}
