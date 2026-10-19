/**
 * Gauges that answer a question about the whole system, refreshed on a timer.
 *
 * Counters are incremented where the thing happens. These three cannot be:
 * "how deep is the queue" and "do the two stores agree" are questions about
 * state, and the honest answer is a query. On a timer rather than during a
 * scrape, so a slow database makes a gauge stale rather than making every
 * scrape time out.
 *
 * All on `system`: these are cross-tenant by nature, which is exactly why they
 * carry no tenant label - the output is a count of affected things.
 */

import { sql } from "drizzle-orm";

import { countScope } from "../db/neo4j.js";
import { system } from "../db/postgres.js";
import { asScanId, asTenantId } from "../tenancy/ids.js";
import { connections, graphMismatches, scanQueueDepth } from "./metrics.js";

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

/** Reconciliation costs one graph query per connection, so it runs less often. */
const RECONCILE_EVERY_TICKS = 5;

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
 * Do Postgres and Neo4j agree about every connection's current graph?
 *
 * The check that was missing when a sweep deleted other accounts' graphs while
 * `projected_at` went on claiming they were there. Node count against the
 * `resource_count` recorded at save time - equal on a healthy deployment,
 * verified against real data (84/84, 54/54) rather than assumed.
 *
 * One graph query per connection: fine at this size, wants sampling at a
 * thousand, and said here so that is a decision rather than a surprise.
 */
export async function refreshGraphReconciliation(): Promise<number> {
  const { rows } = await system.execute<{
    tenant_id: string;
    scan_id: string;
    resource_count: number;
  }>(sql`
    SELECT DISTINCT ON (connection_id) tenant_id, id AS scan_id, resource_count
      FROM scan_runs
     WHERE projected_at IS NOT NULL
     ORDER BY connection_id, projected_at DESC
  `);

  let mismatched = 0;
  for (const row of rows) {
    const { nodes } = await countScope({
      tenantId: asTenantId(row.tenant_id),
      scanId: asScanId(row.scan_id),
    });
    if (nodes !== row.resource_count) mismatched += 1;
  }
  graphMismatches.set(mismatched);
  return mismatched;
}

/**
 * Refresh all of them, for ever, in the process that owns background work.
 *
 * Failures are logged and the loop continues: a gauge that cannot be refreshed
 * is a stale number, and stopping the loop would turn that into a permanently
 * stale one. Unref'd, so this never holds the process open.
 */
export function startSnapshotLoop(log: WarnLogger, everyMs = EVERY_MS): NodeJS.Timeout {
  let tick = 0;

  const run = () => {
    void (async () => {
      try {
        await refreshQueueDepth();
        await refreshConnections();
        if (tick % RECONCILE_EVERY_TICKS === 0) await refreshGraphReconciliation();
      } catch (err) {
        log.warn({ err }, "could not refresh monitoring gauges");
      }
      tick += 1;
    })();
  };

  run();
  const timer = setInterval(run, everyMs);
  timer.unref();
  return timer;
}
