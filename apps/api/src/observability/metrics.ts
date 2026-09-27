/**
 * Prometheus metrics.
 *
 * Chosen for what an operator would actually be paged about, rather than for
 * what is easy to count. Three questions shape the list:
 *
 *   - **Is it up and serving?** Request rate, error rate, latency.
 *   - **Is the product doing its job?** Scans, their outcomes, their duration,
 *     the queue behind them.
 *   - **Is anything quietly wrong?** Partial scans, failed units, unsupported
 *     agent citations, rejected sign-ins.
 *
 * The third group is the interesting one. A scan that half-fails still returns
 * 200, and an answer citing a resource no tool returned still looks like an
 * answer - so neither shows up in request metrics at all. They are exactly the
 * failures this product was built to be honest about, and they need their own
 * counters or they are invisible in aggregate.
 *
 * **No tenant label anywhere.** Prometheus keeps a time series per label
 * combination, so a tenant id would grow the series count without bound and
 * turn a metrics endpoint into a directory of who the customers are. Anything
 * that genuinely needs per-tenant attribution belongs in the logs, which are
 * queryable and access-controlled.
 */

import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

export const registry = new Registry();

registry.setDefaultLabels({ service: "daveio-api" });

// Event loop lag, heap, GC, handles. Cheap, and the first thing to look at
// when "the API is slow" arrives without further detail.
collectDefaultMetrics({ register: registry });

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export const httpRequests = new Counter({
  name: "daveio_http_requests_total",
  help: "HTTP requests by route, method and status class.",
  // `route` is Fastify's *pattern* (/api/resources/:arn), never the resolved
  // URL: the URL contains ARNs, which are customer data and would also give
  // every distinct resource its own time series.
  labelNames: ["route", "method", "status"] as const,
  registers: [registry],
});

export const httpDuration = new Histogram({
  name: "daveio_http_request_duration_seconds",
  help: "HTTP request duration by route.",
  labelNames: ["route", "method"] as const,
  // Buckets chosen for this service rather than the library defaults: reads
  // are single-digit milliseconds, an agent answer is several seconds, and a
  // scan stream can run for minutes.
  buckets: [0.005, 0.025, 0.1, 0.5, 1, 5, 15, 60],
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Scans
// ---------------------------------------------------------------------------

export const scansStarted = new Counter({
  name: "daveio_scans_started_total",
  help: "Scans started.",
  registers: [registry],
});

export const scansFinished = new Counter({
  name: "daveio_scans_finished_total",
  help: "Scans finished, by outcome.",
  // `partial` is deliberately its own outcome and not folded into success: a
  // scan that half-failed returns 200 and looks healthy in request metrics.
  labelNames: ["status"] as const,
  registers: [registry],
});

export const scanDuration = new Histogram({
  name: "daveio_scan_duration_seconds",
  help: "Wall-clock duration of a scan.",
  buckets: [1, 5, 15, 30, 60, 120, 300, 900],
  registers: [registry],
});

export const scanUnitsFailed = new Counter({
  name: "daveio_scan_units_failed_total",
  help: "Failed (service, region) units, by AWS service and error code.",
  /**
   * `aws_service`, not `service`.
   *
   * The registry sets a default `service="daveio-api"` label on everything,
   * and a metric carrying its own `service` would silently overwrite it -
   * producing a series that claims the application is called "rds". The
   * collision is invisible in the code and obvious only in a dashboard that
   * has stopped making sense.
   */
  labelNames: ["aws_service", "code"] as const,
  registers: [registry],
});

export const awsApiCalls = new Counter({
  name: "daveio_aws_api_calls_total",
  help: "AWS API calls made by scans. Rate limiting shows up here first.",
  registers: [registry],
});

export const scanQueueDepth = new Gauge({
  name: "daveio_scan_queue_depth",
  help: "Scan jobs queued or running.",
  labelNames: ["status"] as const,
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export const agentQuestions = new Counter({
  name: "daveio_agent_questions_total",
  help: "Questions asked of the agent, by outcome.",
  labelNames: ["outcome"] as const,
  registers: [registry],
});

export const agentToolCalls = new Counter({
  name: "daveio_agent_tool_calls_total",
  help: "Tool calls by name. Which tools the model actually reaches for.",
  labelNames: ["tool"] as const,
  registers: [registry],
});

export const agentDuration = new Histogram({
  name: "daveio_agent_answer_duration_seconds",
  help: "Time to a complete answer.",
  buckets: [1, 2, 5, 10, 20, 45, 90],
  registers: [registry],
});

/**
 * Citations an answer made that no tool returned.
 *
 * The single most important number in this file. It is the mechanism behind
 * "how do you know it isn't making things up" (ADR-006), and an answer
 * carrying one is still a 200 with a fluent paragraph in it - so if this is
 * not graphed, a regression in grounding is invisible until a customer acts
 * on a resource that does not exist.
 */
export const agentUnsupportedCitations = new Counter({
  name: "daveio_agent_unsupported_citations_total",
  help: "ARNs cited in an answer that no tool returned.",
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Tenancy
// ---------------------------------------------------------------------------

export const authFailures = new Counter({
  name: "daveio_auth_failures_total",
  help: "Rejected sign-ins and unauthenticated requests, by reason.",
  labelNames: ["reason"] as const,
  registers: [registry],
});

export const tenants = new Gauge({
  name: "daveio_tenants",
  help: "Tenants, by whether they have a verified AWS connection.",
  labelNames: ["state"] as const,
  registers: [registry],
});

/** Status class rather than the exact code: 404 and 409 are not a fleet-wide concern. */
export function statusClass(statusCode: number): string {
  return `${Math.floor(statusCode / 100)}xx`;
}
