/**
 * Request metrics, and the endpoint Prometheus scrapes.
 *
 * One pair of hooks rather than per-handler instrumentation, for the same
 * reason authentication is one `preHandler`: a route added next month is
 * counted without anyone remembering to count it.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { httpDuration, httpRequests, registry, statusClass } from "./metrics.js";
import { scanQueueDepth, tenants } from "./metrics.js";
import { pool } from "../db/postgres.js";
import { isHosted } from "../config.js";

/** Nanosecond start time, stashed on the request. */
const START = Symbol("metrics-start");

export function registerMetrics(app: FastifyInstance): void {
  app.addHook("onRequest", async (req) => {
    (req as FastifyRequest & { [START]?: bigint })[START] = process.hrtime.bigint();
  });

  app.addHook("onResponse", async (req, reply: FastifyReply) => {
    /**
     * The route *pattern*, never the URL.
     *
     * `/api/resources/:arn` rather than the ARN itself: the URL is customer
     * data, and using it as a label would also mint a new time series per
     * resource, which is how a metrics endpoint becomes an outage.
     */
    const route = req.routeOptions?.url ?? "unmatched";
    if (route === "/metrics") return;

    const labels = { route, method: req.method };
    httpRequests.inc({ ...labels, status: statusClass(reply.statusCode) });

    const started = (req as FastifyRequest & { [START]?: bigint })[START];
    if (started !== undefined) {
      httpDuration.observe(labels, Number(process.hrtime.bigint() - started) / 1e9);
    }
  });

  /**
   * The scrape endpoint.
   *
   * Unauthenticated, and deliberately so: it is scraped by Prometheus inside
   * the cluster, which has no session, and it carries no tenant identifiers,
   * no ARNs and no secrets - see the label discipline in metrics.ts. In the
   * cluster it is reachable only on the pod network; the tunnel exposes the
   * web service, not this.
   */
  app.get("/metrics", async (_req, reply) => {
    await refreshGauges();
    reply.header("Content-Type", registry.contentType);
    return reply.send(await registry.metrics());
  });
}

/**
 * Gauges describe a current state rather than an accumulating count, so they
 * are read at scrape time rather than maintained by every writer - which would
 * mean every path that touches a job or a tenant remembering to adjust them.
 *
 * Failures are swallowed: a database hiccup must degrade the metrics endpoint,
 * not take it down, because the endpoint is what an operator reaches for while
 * diagnosing that hiccup.
 */
async function refreshGauges(): Promise<void> {
  try {
    const { rows } = await pool.query<{ status: string; n: string }>(
      `SELECT status, count(*)::text AS n FROM scan_jobs
        WHERE status IN ('queued','running') GROUP BY status`,
    );
    scanQueueDepth.reset();
    for (const status of ["queued", "running"]) {
      const row = rows.find((r) => r.status === status);
      scanQueueDepth.set({ status }, Number(row?.n ?? 0));
    }

    if (isHosted()) {
      const { rows: counts } = await pool.query<{ state: string; n: string }>(
        `SELECT CASE
                  WHEN c.status = 'verified' THEN 'connected'
                  WHEN c.tenant_id IS NOT NULL THEN 'pending'
                  ELSE 'unconnected'
                END AS state,
                count(*)::text AS n
           FROM tenants t
           LEFT JOIN connections c ON c.tenant_id = t.id
          GROUP BY 1`,
      );
      tenants.reset();
      for (const row of counts) tenants.set({ state: row.state }, Number(row.n));
    }
  } catch {
    // Stale gauges beat a 500 from the endpoint an operator is using to find
    // out what is wrong.
  }
}
