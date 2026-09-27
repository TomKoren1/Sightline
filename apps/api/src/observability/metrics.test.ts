/**
 * Metric hygiene.
 *
 * Not "does the counter count" - prom-client does that. These check the two
 * properties that make a metrics endpoint safe to expose without
 * authentication, both of which are easy to break by accident later:
 *
 *   1. **No unbounded label values.** Prometheus keeps a time series per label
 *      combination, so a label carrying an ARN, a URL or a tenant id does not
 *      merely leak - it grows without bound until the scrape is the outage.
 *   2. **No customer data.** A metrics endpoint is scraped by something with
 *      no session and retained for months.
 */

import { describe, expect, it } from "vitest";

import * as metrics from "./metrics.js";
import { registry, statusClass } from "./metrics.js";

/**
 * The declared label names, read off the metric objects themselves.
 *
 * The first version of this read `registry.getMetricsAsJSON()`, which does
 * **not** include `labelNames` - so every check below was reading `undefined`
 * and passing on an empty list. It was proven vacuous the only way these
 * things are: by adding a `tenant_id` label on purpose and watching the suite
 * stay green.
 */
function declaredLabels(): Array<{ name: string; labels: string[] }> {
  const out: Array<{ name: string; labels: string[] }> = [];
  for (const value of Object.values(metrics)) {
    const candidate = value as { name?: unknown; labelNames?: unknown };
    if (typeof candidate.name === "string" && Array.isArray(candidate.labelNames)) {
      out.push({ name: candidate.name, labels: candidate.labelNames as string[] });
    }
  }
  return out;
}

describe("status classes", () => {
  it("bucket by class rather than exact code", () => {
    // 404 and 409 are routine here (a resource that moved, a scan already
    // running); a series per code would be noise with a cardinality cost.
    expect(statusClass(200)).toBe("2xx");
    expect(statusClass(404)).toBe("4xx");
    expect(statusClass(503)).toBe("5xx");
  });
});

describe("the label names this service declares", () => {
  /** Anything whose value cannot be enumerated in advance. */
  const FORBIDDEN = [
    "tenant",
    "tenantid",
    "tenant_id",
    "arn",
    "url",
    "path",
    "user",
    "email",
    "account",
  ];

  it("finds labelled metrics to inspect at all", () => {
    // Without this, every check below passes by examining nothing - which is
    // exactly how the first version of this file was wrong.
    const declared = declaredLabels();
    expect(declared.length).toBeGreaterThan(5);
    expect(declared.some((m) => m.labels.length > 0)).toBe(true);
  });

  it("declares no unbounded label", () => {
    const offenders: string[] = [];
    for (const metric of declaredLabels()) {
      for (const label of metric.labels) {
        if (FORBIDDEN.includes(label.toLowerCase())) offenders.push(`${metric.name}{${label}}`);
      }
    }
    expect(
      offenders,
      "these labels carry values that cannot be enumerated - per-tenant detail belongs in the logs",
    ).toEqual([]);
  });

  /**
   * The registry sets `service="daveio-api"` on everything. A metric that
   * declares its own `service` label overwrites it, producing a series that
   * claims the application is called "rds" - invisible in the code, and
   * obvious only in a dashboard that has stopped making sense.
   */
  it("does not shadow the default service label", () => {
    const shadowing = declaredLabels()
      .filter((m) => m.labels.includes("service"))
      .map((m) => m.name);
    expect(shadowing).toEqual([]);
  });

  it("exposes the counter that makes ungrounded answers visible", async () => {
    // Named explicitly: it is the one metric whose absence would hide a
    // regression in the property this product is built on (ADR-006).
    const names = (await registry.getMetricsAsJSON()).map((m) => m.name);
    expect(names).toContain("daveio_agent_unsupported_citations_total");
  });

  it("separates partial scans from successful ones", async () => {
    const names = (await registry.getMetricsAsJSON()).map((m) => m.name);
    expect(names).toContain("daveio_scans_finished_total");
  });
});

describe("the rendered exposition", () => {
  it("is valid Prometheus text with help and type lines", async () => {
    const text = await registry.metrics();
    expect(text).toContain("# HELP daveio_http_requests_total");
    expect(text).toContain("# TYPE daveio_http_requests_total counter");
  });

  it("carries no ARN, URL or email, whatever has been recorded", async () => {
    const text = await registry.metrics();
    expect(text).not.toMatch(/arn:aws/);
    expect(text).not.toMatch(/https?:\/\/(?!localhost)/);
    expect(text).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/i);
  });
});
