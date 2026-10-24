/**
 * A scan's progress, reconstructed from the database.
 *
 * The old stream existed only in the request that started it: closing the tab
 * orphaned the scan. These events are derived from `scan_jobs`, `scan_runs` and
 * `scan_units`, so many clients can watch one scan, a reload rejoins it, and
 * the process doing the work needs no connection to any browser.
 *
 * Polling, not `LISTEN/NOTIFY`: units finish seconds apart, so a one-second
 * poll is indistinguishable from push at human resolution and costs two indexed
 * queries rather than a connection per watching tab.
 *
 * What is emitted depends on what this stream has already sent, which is why
 * the sent-set is local to the generator - two tabs each get a complete picture
 * from where they joined.
 */

import type { ScanEvent, ScanRun, ScanUnit } from "@sightline/shared";

import { withTenant } from "../db/postgres.js";
import { getScan } from "../db/repository.js";
import type { JobId } from "../core/ids.js";
import type { Scope } from "../core/scope.js";
import { getJob, TERMINAL, type JobStatus } from "./queue.js";

/**
 * How often the rows are re-read while a scan is in flight.
 *
 * Short enough that a fast scan still looks like progress rather than one jump:
 * against the mock account the whole thing takes about three seconds, which a
 * one-second poll reduced to three or four observations. The cost is two
 * indexed queries per watcher per tick, and the number of watchers is bounded
 * by the number of scans actually running.
 */
const PROGRESS_POLL_MS = 400;

/**
 * How long to keep streaming with the job in a state that should not last.
 *
 * A job claimed by a worker that then died is `running` with a stale heartbeat
 * until a reclaim notices. That is recoverable, but a browser should not hold a
 * connection open indefinitely waiting for it, so the stream gives up and says
 * so - the scan carries on, and reopening the stream rejoins it.
 */
const STREAM_IDLE_LIMIT_MS = 10 * 60_000;

export interface ScanProgress {
  status: JobStatus;
  queuedAt: string;
  scanId: string | null;
  run: ScanRun | null;
  error: string | null;
}

/** Everything known about one of this tenant's scan jobs, or null. */
export async function readProgress(scope: Scope, jobId: JobId): Promise<ScanProgress | null> {
  return withTenant(scope.tenantId, async () => {
    const job = await getJob(scope, jobId);
    if (!job) return null;

    // Scoped twice over: the job was read as this tenant's, and the run is read
    // with the same scope rather than by id alone.
    const run = job.scanId ? await getScan(scope, job.scanId) : null;

    return {
      status: job.status,
      queuedAt: job.queuedAt.toISOString(),
      scanId: job.scanId,
      run,
      error: job.error,
    };
  });
}

/** A unit's identity within a scan. `region` is null for a global service. */
const unitKey = (unit: Pick<ScanUnit, "service" | "region">): string =>
  `${unit.service}:${unit.region ?? "global"}`;

/** A unit that will not change again. */
const isTerminal = (status: ScanUnit["status"]): boolean =>
  status === "succeeded" || status === "failed";

/** How many units this stream has reported as finished. */
const countReported = (reported: Map<string, ScanUnit["status"]>): number =>
  [...reported.values()].filter(isTerminal).length;

/**
 * Events for a scan, from wherever it has got to, until it ends.
 *
 * An async generator so the transport is somebody else's problem: the HTTP
 * handler writes what this yields, and a test iterates it directly without a
 * socket. The caller is responsible for stopping early - `return()` on the
 * generator - when the client disconnects.
 */
export async function* streamScanEvents(
  scope: Scope,
  jobId: JobId,
  options: { pollMs?: number; idleLimitMs?: number; now?: () => number } = {},
): AsyncGenerator<ScanEvent> {
  const pollMs = options.pollMs ?? PROGRESS_POLL_MS;
  const idleLimitMs = options.idleLimitMs ?? STREAM_IDLE_LIMIT_MS;
  const now = options.now ?? Date.now;

  /** Units already reported, and in what state, so only changes are sent. */
  const reported = new Map<string, ScanUnit["status"]>();
  let announcedStart = false;
  let announcedQueued = false;
  let lastProgress = -1;
  const startedAt = now();

  for (;;) {
    const progress = await readProgress(scope, jobId);
    if (!progress) {
      // The job is gone, or was never this tenant's. Either way there is
      // nothing to watch and nothing useful to say about it.
      return;
    }

    if (progress.status === "queued" && !announcedQueued) {
      announcedQueued = true;
      yield { type: "scan.queued", scanId: jobId, queuedAt: progress.queuedAt };
    }

    const run = progress.run;
    if (run && !announcedStart) {
      announcedStart = true;
      /**
       * The full plan, as it stands now.
       *
       * A client joining a scan that is already half done gets every unit with
       * its current status, not a list that grows from empty - so a reloaded
       * page looks like the page that never reloaded. The units it then reports
       * as already seen are exactly these.
       */
      yield {
        type: "scan.started",
        scanId: run.id,
        regions: run.regions,
        units: run.units,
        accountId: run.accountId,
      };
      /**
       * Deliberately *not* marking these units as already reported.
       *
       * The first version did, and it cost the stream almost all of its
       * events: a poll that lands after several units have finished would
       * record them as seen at their final status, and they never got a
       * `unit.finished` at all. Against the mock, whose whole scan takes about
       * three seconds, fourteen unit events became one - a progress bar that
       * jumps from nothing to done, and a CI assertion that more than five
       * units stream would have failed.
       *
       * Leaving the set empty gives the property worth having: every unit
       * produces exactly one `unit.finished`, whenever the client joined and
       * however the polls happen to line up. `scan.started` carries the plan
       * with current statuses so a rejoining client renders correctly
       * immediately; the unit events that follow agree with it rather than
       * contradicting it.
       */
    }

    if (run) {
      for (const unit of run.units) {
        const key = unitKey(unit);
        if (reported.get(key) === unit.status) continue;
        reported.set(key, unit.status);
        // `unit.finished` for anything terminal, `unit.started` otherwise:
        // the two the UI distinguishes.
        if (isTerminal(unit.status)) {
          yield { type: "unit.finished", scanId: run.id, unit };
          /**
           * Progress after each unit, not once per poll.
           *
           * The progress bar is driven by this event and not by the unit list,
           * so emitting it once per poll made the bar jump from nothing to
           * complete whenever several units finished between two polls - which
           * against the mock account is all of them. One per unit matches what
           * the in-request stream did, and costs nothing: the count comes from
           * what has already been reported rather than another query.
           */
          lastProgress = countReported(reported);
          yield {
            type: "scan.progress",
            scanId: run.id,
            completed: lastProgress,
            total: run.units.length,
          };
        } else if (unit.status === "running") {
          yield {
            type: "unit.started",
            scanId: run.id,
            service: unit.service,
            region: unit.region,
          };
        }
      }

      // A correction, for the case where the rows say more is done than the
      // events accounted for - a unit that went straight to terminal in a scan
      // this stream joined late, say.
      const completed = run.units.filter((u) => isTerminal(u.status)).length;
      if (completed !== lastProgress) {
        lastProgress = completed;
        yield { type: "scan.progress", scanId: run.id, completed, total: run.units.length };
      }
    }

    if (TERMINAL.has(progress.status)) {
      /**
       * A terminal job with a run row is reported from the run, which carries
       * the units and counts the UI wants. Without one the scan never got far
       * enough to have a row - assuming the role failed, say - and the job's
       * error is the only thing there is to say.
       */
      if (progress.status === "cancelled") {
        yield {
          type: "scan.failed",
          scanId: progress.scanId ?? jobId,
          error: "This scan was cancelled before it started.",
        };
      } else if (run && progress.status !== "failed") {
        yield { type: "scan.finished", scanId: run.id, run };
      } else {
        yield {
          type: "scan.failed",
          scanId: progress.scanId ?? jobId,
          error: progress.error ?? run?.error ?? "The scan failed.",
        };
      }
      return;
    }

    if (now() - startedAt > idleLimitMs) {
      yield {
        type: "scan.failed",
        scanId: progress.scanId ?? jobId,
        error:
          "This scan has not reported progress for a long time, so Sightline stopped watching " +
          "it. The scan itself may still be running; reload to pick it up again.",
      };
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
