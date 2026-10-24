/**
 * Gauges that answer a question about the whole system, refreshed on a timer.
 *
 * Counters are incremented where the thing happens. These cannot be: "how
 * deep is the queue" and "how many connections are healthy" are questions about
 * state, and the honest answer is a query. On a timer rather than during a
 * scrape, so a slow database makes a gauge stale rather than making every
 * scrape time out.
 *
 * All on `system`: these are cross-tenant by nature, which is exactly why they
 * carry no tenant label - the output is a count of affected things.
 */

import { sql } from "drizzle-orm";

import { system } from "../db/postgres.js";
import { connections, scanQueueDepth } from "../observability/metrics.js";

/**
 * The one method this needs, structurally.
 *
 * The API's logger is Fastify's and the worker's is pino's; they share this
 * shape and nothing else worth depending on.
 */
interface WarnLogger {
  warn: (obj: object, msg: string) => void;
}

/** How often the cheap gauges are refreshed. */
const EVERY_MS = 60_000;

export async function refreshQueueDepth(): Promise<void> {
  const { rows } = await system.execute<{ status: string; n: number }>(sql`
    SELECT status, count(*)::int AS n FROM scan_jobs GROUP BY status
  `);
  // Reset first: a status that drops to zero must report zero rather than
  // keeping whatever it last had, which is how a drained queue looks stuck.
  scanQueueDepth.reset();
  for (const row of rows) scanQueueDepth.set({ status: row.status }, row.n);
}

export async function refreshConnections(): Promise<void> {
  const { rows } = await system.execute<{ status: string; n: number }>(sql`
    SELECT status, count(*)::int AS n FROM connections GROUP BY status
  `);
  connections.reset();
  for (const row of rows) connections.set({ status: row.status }, row.n);
}

/**
 * Refresh all of them, for ever, in the process that owns background work.
 *
 * Failures are logged and the loop continues: a gauge that cannot be refreshed
 * is a stale number, and stopping the loop would turn that into a permanently
 * stale one. Unref'd, so this never holds the process open.
 */
export function startSnapshotLoop(log: WarnLogger, everyMs = EVERY_MS): NodeJS.Timeout {
  const run = () => {
    void (async () => {
      try {
        await refreshQueueDepth();
        await refreshConnections();
      } catch (err) {
        log.warn({ err }, "could not refresh monitoring gauges");
      }
    })();
  };

  run();
  const timer = setInterval(run, everyMs);
  timer.unref();
  return timer;
}
