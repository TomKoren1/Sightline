/**
 * The scan this page is showing: one it started, or one already running when
 * it loaded. Progress arrives as events from the server either way, so both
 * paths share one handler.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ScanEvent, ScanUnit } from "@sightline/shared";
import { errorMessage } from "@sightline/shared";

import { startScan, watchScan } from "../api.js";

export function useScanSession(activeJobId: string | null, onStart?: () => void) {
  const queryClient = useQueryClient();
  const [scanning, setScanning] = useState(false);
  const [queued, setQueued] = useState(false);
  const [progress, setProgress] = useState<{ completed: number; total: number } | null>(null);
  const [liveUnits, setLiveUnits] = useState<ScanUnit[]>([]);
  const [scanError, setScanError] = useState<string | null>(null);

  /**
   * One handler, whether this page started the scan or joined one in progress.
   *
   * Both paths receive the same events from the same place - the server derives
   * them from the database rather than from whichever request happened to start
   * the scan - so there is no reason for two copies of this, and a second copy
   * is how a rejoined scan ends up rendering slightly differently.
   */
  const onScanEvent = useCallback((event: ScanEvent) => {
    switch (event.type) {
      case "scan.queued":
        // Waiting for a worker. Saying so beats an idle progress bar, which is
        // indistinguishable from the scan having failed to start.
        setQueued(true);
        break;
      case "scan.started":
        setQueued(false);
        // The full plan arrives up front, so the UI shows every service it
        // intends to scan rather than growing a list as work completes. On a
        // rejoin these carry the statuses they already have.
        setLiveUnits(event.units);
        setProgress({
          completed: event.units.filter((u) => u.status === "succeeded" || u.status === "failed")
            .length,
          total: event.units.length,
        });
        break;
      case "unit.finished":
        setLiveUnits((prev) =>
          prev.map((u) =>
            u.service === event.unit.service && u.region === event.unit.region ? event.unit : u,
          ),
        );
        break;
      case "scan.progress":
        setProgress({ completed: event.completed, total: event.total });
        break;
      case "scan.failed":
        setScanError(event.error);
        break;
      default:
        break;
    }
  }, []);

  const refreshAfterScan = useCallback(
    () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ["latestScan"] }),
        queryClient.invalidateQueries({ queryKey: ["graph"] }),
        queryClient.invalidateQueries({ queryKey: ["summary"] }),
        queryClient.invalidateQueries({ queryKey: ["findings"] }),
      ]),
    [queryClient],
  );

  const runScan = useCallback(async () => {
    setScanning(true);
    setScanError(null);
    setLiveUnits([]);
    setProgress(null);
    onStart?.();

    try {
      await startScan(onScanEvent);
      await refreshAfterScan();
    } catch (err) {
      setScanError(errorMessage(err));
    } finally {
      setScanning(false);
      setQueued(false);
    }
  }, [onScanEvent, refreshAfterScan, onStart]);

  /**
   * Rejoin a scan that was already running when this page loaded.
   *
   * The thing the job queue bought. A scan used to live inside the request that
   * started it, so reloading mid-scan orphaned it and left the page showing
   * nothing until it finished. Now the server names the active job and this
   * attaches to it, from wherever it has got to.
   *
   * The ref is what stops it attaching twice: this effect re-runs whenever the
   * `latestScan` query refetches, and without it every refetch would open
   * another stream onto the same scan.
   */
  const watching = useRef<string | null>(null);

  useEffect(() => {
    if (!activeJobId || scanning || watching.current === activeJobId) return;
    watching.current = activeJobId;
    setScanning(true);
    setScanError(null);

    const controller = new AbortController();
    void (async () => {
      try {
        await watchScan(activeJobId, onScanEvent, controller.signal);
        await refreshAfterScan();
      } catch (err) {
        // An aborted stream is this component unmounting, not a failure.
        if (!controller.signal.aborted) setScanError(errorMessage(err));
      } finally {
        setScanning(false);
        setQueued(false);
        watching.current = null;
      }
    })();

    return () => controller.abort();
  }, [activeJobId, scanning, onScanEvent, refreshAfterScan]);

  return { scanning, queued, progress, liveUnits, scanError, runScan };
}
