/**
 * Scan reads, and asking for one.
 *
 * Running a scan used to happen here, inside the request that asked for it.
 * That had two consequences worth naming: closing the tab orphaned the scan,
 * and a scan heavy enough to exhaust memory took the API down with it. Both are
 * gone - this enqueues, and a worker runs it. What the request streams is a
 * *view* of the job, read back from Postgres, which is why a reload can rejoin
 * one and why several tabs can watch the same scan.
 */

import { Injectable, NotFoundException } from "@nestjs/common";

import { diffScans, getLatestScan, getScan, listScans } from "../db/repository.js";
import { activeJobId, cancelQueuedJob, enqueueScan, getJob, type ScanJob } from "../jobs/queue.js";
import { readProgress, streamScanEvents } from "../jobs/progress.js";
import { mayScan } from "../tenancy/limits.js";
import { ScanRefused } from "./scanRefused.js";
import { asScanId, type JobId, type ScanId } from "../tenancy/ids.js";
import type { Scope } from "../tenancy/scope.js";

@Injectable()
export class ScansService {
  async list(scope: Scope) {
    return { scans: await listScans(scope, 20) };
  }

  async latest(scope: Scope) {
    /**
     * The active job's id, not just a boolean.
     *
     * `scanning: true` was enough when the scan lived in the request that
     * started it, because the only client that could be watching was the one
     * holding that response open. Now a page that reloads mid-scan has to be
     * able to *find* the scan again, and an id is the difference between
     * rejoining it and showing a spinner that never resolves.
     */
    const jobId = await activeJobId(scope);
    // A null scan is not an error: a connection nobody has scanned is a normal
    // first-run state, and the UI renders an empty state from this.
    return {
      scan: await getLatestScan(scope),
      scanning: jobId !== null,
      activeJobId: jobId,
    };
  }

  async byId(scope: Scope, id: ScanId) {
    const scan = await getScan(scope, id);
    // Tenant-scoped, so a scan belonging to someone else is indistinguishable
    // from one that does not exist. That is the right answer to give.
    if (!scan) throw new NotFoundException({ error: "No such scan" });
    return { scan };
  }

  async diff(scope: Scope, query: { from?: ScanId; to?: ScanId }) {
    let { from, to } = query;
    if (!from || !to) {
      const scans = await listScans(scope, 2);
      if (scans.length < 2) {
        return { diff: null, reason: "Only one scan exists; nothing to compare yet." };
      }
      // Branded on the way out of the database as well as on the way in from
      // a request. These came from `scan_runs.id` so they cannot fail, and
      // saying so costs a regex rather than a reader working out which ids on
      // this path were checked.
      to ??= asScanId(scans[0]!.id);
      from ??= asScanId(scans[1]!.id);
    }
    return { diff: await diffScans(scope, from, to) };
  }

  /**
   * Queue a scan.
   *
   * Throws `ScanAlreadyQueued` if one is already in flight - that one is the
   * database's answer, from the partial unique index - and `ScanRefused` for
   * the limits a schema cannot express: a kill switch, a cooldown, a cap across
   * the tenant's accounts.
   */
  async enqueue(scope: Scope, requestedBy: string | null): Promise<ScanJob> {
    const decision = await mayScan(scope);
    if (!decision.allowed) throw new ScanRefused(decision);
    return enqueueScan(scope, requestedBy);
  }

  /** Progress for one job, or null if it is not this tenant's. */
  async progress(scope: Scope, jobId: JobId) {
    const progress = await readProgress(scope, jobId);
    if (!progress) throw new NotFoundException({ error: "No such scan job" });
    return progress;
  }

  /**
   * Events for a job, from wherever it has got to.
   *
   * Returns the generator rather than consuming it, so the controller owns the
   * socket and this stays testable without one.
   */
  events(scope: Scope, jobId: JobId) {
    return streamScanEvents(scope, jobId);
  }

  async job(scope: Scope, jobId: JobId): Promise<ScanJob | null> {
    return getJob(scope, jobId);
  }

  /** Cancel a job that has not started. Returns false if it already has. */
  async cancel(scope: Scope, jobId: JobId): Promise<boolean> {
    return cancelQueuedJob(scope, jobId);
  }
}
