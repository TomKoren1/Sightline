/**
 * No metric may identify a customer, and the names follow the conventions.
 *
 * The first half matters most: metrics go to a store with no tenant isolation,
 * so a `tenant_id` label would put customer identity outside everything the
 * isolation design covers. It is also the easiest mistake to make - a tenant
 * label is what somebody debugging one customer's scan reaches for.
 *
 * Enumerated from the registry, so a metric added later is covered.
 */

import { describe, expect, it } from "vitest";

import type { GuardCause } from "../agent/sqlGuard.js";
import {
  AGENT_OUTCOMES,
  AGENT_TOKEN_KINDS,
  FORBIDDEN_LABELS,
  RAW_QUERY_REFUSALS,
  registry,
  startMetricsServer,
} from "./metrics.js";

interface Described {
  name: string;
  type: string;
  help: string;
  labelNames: string[];
}

/**
 * Name, type, help *and* labels for every registered metric.
 *
 * Both calls, deliberately. `getMetricsAsJSON` carries the type and help text
 * but **not** `labelNames`; `getMetricsAsArray` carries the labels. The first
 * version of this file used only the JSON form, so `labelNames` was always
 * `undefined`, and the forbidden-label assertion below passed against an empty
 * array - it was decoration. Found by adding `tenant_id` to a real metric and
 * watching the test stay green.
 */
async function described(): Promise<Described[]> {
  const labels = new Map(
    registry.getMetricsAsArray().map((m) => {
      // `MetricObject` does not declare `labelNames`, though every registered
      // metric carries it. Verified against prom-client 15 rather than assumed.
      const withLabels = m as { name: string; labelNames?: readonly string[] };
      return [withLabels.name, [...(withLabels.labelNames ?? [])]];
    }),
  );
  const json = (await registry.getMetricsAsJSON()) as unknown as Omit<Described, "labelNames">[];
  return json.map((m) => ({ ...m, labelNames: labels.get(m.name) ?? [] }));
}

const ours = (m: Described) => m.name.startsWith("sightline_") || m.name.startsWith("http_");

describe("the metrics registry", () => {
  it("registered the metrics this file is about", async () => {
    // Without this every assertion below passes on an empty registry.
    const all = await described();
    expect(all.filter(ours).length).toBeGreaterThan(20);
    expect(all.map((m) => m.name)).toContain("sightline_scan_queue_depth");
    // And labels are actually being read, which is what went wrong once: a
    // check over labels nobody could see passed every time.
    expect(all.flatMap((m) => m.labelNames)).toContain("route");
  });

  it("carries no label that identifies a customer", async () => {
    const forbidden = new Set<string>(FORBIDDEN_LABELS);
    const offenders = (await described()).flatMap((m) =>
      (m.labelNames ?? [])
        .filter((label) => forbidden.has(label))
        .map((label) => `${m.name}{${label}}`),
    );

    expect(
      offenders,
      "these labels identify one customer rather than one kind of thing. Prometheus has no " +
        "tenant isolation and keeps series for a fortnight, and each distinct value is a new " +
        "series. Aggregate instead: a count of affected connections, not a series per tenant.",
    ).toEqual([]);
  });

  it("names things the way Prometheus expects", async () => {
    const problems: string[] = [];
    for (const m of (await described()).filter(ours)) {
      // Counters end `_total`; nothing else may.
      const isTotal = m.name.endsWith("_total");
      if (m.type === "counter" && !isTotal) problems.push(`${m.name} is a counter without _total`);
      if (m.type !== "counter" && isTotal)
        problems.push(`${m.name} ends _total but is a ${m.type}`);

      // Base units, never milliseconds - the convention every dashboard and
      // every `rate()` expression assumes.
      if (["_ms", "_millis", "_milliseconds"].some((s) => m.name.endsWith(s))) {
        problems.push(`${m.name} should be seconds`);
      }
      /**
       * A histogram must say what it measures in its own name.
       *
       * The exceptions are counts of things, which have no SI unit to name.
       * Kept as an explicit list rather than a looser rule, so adding one is a
       * decision somebody makes on purpose - the point of the check is to stop
       * `_duration` arriving in milliseconds.
       */
      const unitInName = ["_seconds", "_bytes", "_resources", "_steps"].some((s) =>
        m.name.endsWith(s),
      );
      if (m.type === "histogram" && !unitInName) {
        problems.push(`${m.name} is a histogram with no unit in its name`);
      }

      // Help text is what somebody reads in Grafana's metric browser at 2am.
      if (!m.help || m.help.length < 15) problems.push(`${m.name} has no useful help text`);
    }
    expect(problems).toEqual([]);
  });

  it("serves the registry on its own port, and nothing else", async () => {
    // Port 0 lets the OS choose, so this cannot collide with a running API.
    const server = startMetricsServer(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    try {
      const metrics = await fetch(`http://127.0.0.1:${port}/metrics`);
      expect(metrics.status).toBe(200);
      expect(metrics.headers.get("content-type")).toContain("text/plain");
      const body = await metrics.text();
      // Default process metrics, so a scrape says something even before a scan.
      expect(body).toContain("process_resident_memory_bytes");
      expect(body).toContain("sightline_");

      // Any other path is a 404 rather than a listing: this port has exactly
      // one consumer, and anything else asking is not a client.
      const other = await fetch(`http://127.0.0.1:${port}/`);
      expect(other.status).toBe(404);
    } finally {
      server.close();
    }
  });
});

describe("the agent's counters before anyone asks", () => {
  it("expose every outcome, token kind and refusal at zero", async () => {
    // A dashboard ratio over a series that does not exist yet shows "No data".
    const text = await registry.metrics();
    for (const outcome of AGENT_OUTCOMES) {
      expect(text).toContain(`sightline_agent_questions_total{outcome="${outcome}"}`);
    }
    for (const kind of AGENT_TOKEN_KINDS) {
      expect(text).toContain(`sightline_agent_tokens_total{kind="${kind}"}`);
    }
    for (const reason of RAW_QUERY_REFUSALS) {
      expect(text).toContain(`sightline_agent_raw_query_refused_total{reason="${reason}"}`);
    }
  });

  it("list every cause the SQL guard can refuse with", () => {
    // Fails to compile, not just to run, when the guard gains a cause.
    const covered: Exclude<GuardCause, (typeof RAW_QUERY_REFUSALS)[number]> extends never
      ? true
      : false = true;
    expect(covered).toBe(true);
  });
});
