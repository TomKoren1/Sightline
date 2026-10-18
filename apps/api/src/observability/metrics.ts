/**
 * What this process reports about itself, for Prometheus to scrape.
 *
 * On its own port, not a route: the worker serves no HTTP and would otherwise
 * be unobservable, and nginx proxies only the application port - so `/metrics`
 * is unreachable from the internet by construction.
 *
 * **No label may identify a tenant.** These series land in a shared store with
 * no tenant isolation, so a tenant label would put customer identity outside
 * everything that design covers, and multiply series by the customer count.
 * `metrics.test.ts` enforces it against every registered metric.
 */

import { createServer, type Server } from "node:http";
import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from "prom-client";

export const registry = new Registry();

/**
 * Heap, event-loop lag, GC, file descriptors.
 *
 * Worth having before any metric of ours: the worker holds an account's whole
 * inventory in memory and is the process that gets OOMKilled, and event-loop
 * lag is how a scan starving the API shows up.
 */
collectDefaultMetrics({ register: registry });

/**
 * Labels no metric may carry, enforced by test.
 *
 * Anything that identifies one customer rather than one *kind* of thing.
 */
export const FORBIDDEN_LABELS = [
  "tenant",
  "tenantId",
  "tenant_id",
  "connection",
  "connectionId",
  "connection_id",
  "user",
  "userId",
  "user_id",
  "email",
  "account",
  "accountId",
  "account_id",
  "arn",
  "scan",
  "scanId",
  "scan_id",
  "externalId",
  "external_id",
] as const;

// --- the four golden signals -----------------------------------------------

/** `route` is the template (`/api/scans/jobs/:id`), never the path, or every id is a series. */
export const httpRequests = new Counter({
  name: "http_requests_total",
  help: "HTTP requests completed, by route template, method and status.",
  labelNames: ["method", "route", "status"],
  registers: [registry],
});

export const httpDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "How long requests took, by route template and method.",
  labelNames: ["method", "route"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const httpInFlight = new Gauge({
  name: "http_requests_in_flight",
  help: "Requests currently being served. Saturation, not traffic.",
  registers: [registry],
});

// --- the scan pipeline ------------------------------------------------------

export const scanQueueDepth = new Gauge({
  name: "sightline_scan_queue_depth",
  help: "Scan jobs in the queue, by status. Queued work nobody is claiming.",
  labelNames: ["status"],
  registers: [registry],
});

/** Enqueue to claim. The wait a person actually feels before anything happens. */
export const scanQueueWait = new Histogram({
  name: "sightline_scan_queue_wait_seconds",
  help: "Time a job waited between being enqueued and being claimed.",
  buckets: [0.1, 0.5, 1, 2, 5, 15, 60, 300],
  registers: [registry],
});

export const scanJobs = new Counter({
  name: "sightline_scan_jobs_total",
  help: "Scan jobs that reached a terminal state, by outcome.",
  labelNames: ["outcome"],
  registers: [registry],
});

export const scanJobsReclaimed = new Counter({
  name: "sightline_scan_jobs_reclaimed_total",
  help: "Jobs taken back from a worker that stopped heartbeating.",
  registers: [registry],
});

export const scanDuration = new Histogram({
  name: "sightline_scan_duration_seconds",
  help: "Wall-clock time for a whole scan, collection through projection.",
  labelNames: ["outcome"],
  buckets: [1, 5, 15, 30, 60, 120, 300, 600, 1800],
  registers: [registry],
});

export const projectionDuration = new Histogram({
  name: "sightline_projection_duration_seconds",
  help: "Time to project one scan's resources into the graph.",
  buckets: [0.1, 0.5, 2, 5, 10, 30, 120],
  registers: [registry],
});

/** Per (service, region) unit: which service in which region is slow. */
export const scanUnitDuration = new Histogram({
  name: "sightline_scan_unit_duration_seconds",
  help: "Time for one service in one region.",
  labelNames: ["service", "region"],
  buckets: [0.05, 0.25, 1, 5, 15, 60],
  registers: [registry],
});

export const scanUnitFailures = new Counter({
  name: "sightline_scan_unit_failures_total",
  help: "Units that failed, by service, region and cause.",
  labelNames: ["service", "region", "reason"],
  registers: [registry],
});

export const scanResources = new Histogram({
  name: "sightline_scan_resources",
  help: "Resources discovered per scan.",
  buckets: [10, 100, 500, 1000, 5000, 20000, 100000],
  registers: [registry],
});

// --- what the scan costs in somebody else's account -------------------------

export const awsApiCalls = new Counter({
  name: "sightline_aws_api_calls_total",
  help: "AWS API calls made, by service and operation.",
  labelNames: ["service", "operation"],
  registers: [registry],
});

export const awsThrottles = new Counter({
  name: "sightline_aws_throttles_total",
  help: "Throttling responses from AWS, by service.",
  labelNames: ["service"],
  registers: [registry],
});

// --- the two stores agreeing with each other --------------------------------

/**
 * Connections whose graph does not match what Postgres recorded.
 *
 * The signal that was missing when a sweep deleted other accounts' graphs while
 * `scan_runs.projected_at` went on claiming they were there. One number rather
 * than a series per connection: the question is "is anything wrong", and the
 * answer being a count keeps it free of tenant labels.
 */
export const graphMismatches = new Gauge({
  name: "sightline_graph_reconciliation_mismatches",
  help: "Connections where the graph's node count disagrees with Postgres.",
  registers: [registry],
});

// --- the agent, where the money goes ----------------------------------------

export const agentQuestions = new Counter({
  name: "sightline_agent_questions_total",
  help: "Questions asked of the agent, by outcome.",
  labelNames: ["outcome"],
  registers: [registry],
});

export const agentTokens = new Counter({
  name: "sightline_agent_tokens_total",
  help: "Anthropic tokens consumed, by input or output.",
  labelNames: ["kind"],
  registers: [registry],
});

export const agentToolCalls = new Counter({
  name: "sightline_agent_tool_calls_total",
  help: "Tool invocations, by tool. Which questions need which evidence.",
  labelNames: ["tool"],
  registers: [registry],
});

export const agentDuration = new Histogram({
  name: "sightline_agent_duration_seconds",
  help: "Time to answer a question, including tool calls.",
  buckets: [0.5, 1, 2, 5, 10, 30, 60, 120],
  registers: [registry],
});

/**
 * Identifiers the agent cited that the tools never returned.
 *
 * The closest thing to a hallucination rate this product can honestly measure,
 * because the citation validator already computes it per answer.
 */
export const agentUnsupportedCitations = new Counter({
  name: "sightline_agent_unsupported_citations_total",
  help: "Cited identifiers not found in any tool result.",
  registers: [registry],
});

// --- onboarding, which decides whether anyone ever uses this ----------------

export const connections = new Gauge({
  name: "sightline_connections",
  help: "AWS connections, by status. The funnel, as a gauge.",
  labelNames: ["status"],
  registers: [registry],
});

/**
 * Why an AssumeRole was refused, using `diagnose()`'s three causes.
 *
 * Turns "onboarding is hard" into "they are all failing on the ExternalId".
 */
export const assumeRoleFailures = new Counter({
  name: "sightline_assume_role_failures_total",
  help: "Failed role assumptions, by diagnosed cause.",
  labelNames: ["reason"],
  registers: [registry],
});

export const verifyDuration = new Histogram({
  name: "sightline_connection_verify_duration_seconds",
  help: "Time for a connection test to answer.",
  labelNames: ["outcome"],
  buckets: [0.5, 1, 2, 5, 10, 30],
  registers: [registry],
});

// --- limits, and one tenancy smell ------------------------------------------

export const requestsRefused = new Counter({
  name: "sightline_requests_refused_total",
  help: "Requests a limit refused, by kind of refusal and what was asked for.",
  labelNames: ["kind", "what"],
  registers: [registry],
});

/**
 * Requests that named no connection and fell back to the tenant's oldest.
 *
 * The fallback is deliberate and safe, but it is also what made two resource
 * panels answer about the wrong AWS account. A number climbing here means a
 * client is not sending the header.
 */
export const requestsWithoutConnection = new Counter({
  name: "sightline_requests_without_connection_header_total",
  help: "Scoped requests that arrived with no connection header.",
  registers: [registry],
});

// --- which build is being described -----------------------------------------

export const buildInfo = new Gauge({
  name: "sightline_build_info",
  help: "Always 1. The labels are the point.",
  labelNames: ["version", "commit"],
  registers: [registry],
});

/** Record the running build. `GIT_COMMIT` is supplied by the image build. */
export function recordBuild(version: string, commit = process.env["GIT_COMMIT"] ?? "unknown") {
  buildInfo.labels({ version, commit }).set(1);
}

/**
 * Serve the registry, and nothing else.
 *
 * Any other path is a 404 rather than a redirect or a listing: this port exists
 * for one consumer. Bound to all interfaces because Prometheus scrapes it from
 * another pod, which is also why it must never be the application's port.
 */
export function startMetricsServer(port: number, host = "0.0.0.0"): Server {
  const server = createServer((req, res) => {
    if (req.url?.split("?")[0] !== "/metrics") {
      res.statusCode = 404;
      res.end("not found\n");
      return;
    }
    registry
      .metrics()
      .then((body) => {
        res.setHeader("Content-Type", registry.contentType);
        res.end(body);
      })
      .catch((err: unknown) => {
        res.statusCode = 500;
        res.end(err instanceof Error ? err.message : "metrics failed");
      });
  });
  // Scraping is not worth keeping the process alive for.
  server.unref();
  server.listen(port, host);
  return server;
}
