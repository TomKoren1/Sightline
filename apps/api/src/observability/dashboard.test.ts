/**
 * That the dashboard and the code agree.
 *
 * A Grafana dashboard is a JSON file nobody runs, so it rots exactly the way
 * the README did (engineering log #35): a metric gets renamed, every test
 * still passes, and the panel quietly shows "No data" until somebody needs it
 * during an incident.
 *
 * So: every metric the dashboard queries must exist in the registry, and the
 * ConfigMap must contain the same dashboard as the file beside it.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { registry } from "./metrics.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const dashboardPath = `${root}deploy/dashboards/daveio-api.json`;
const configMapPath = `${root}deploy/grafana-dashboard-configmap.yaml`;

const dashboard = JSON.parse(readFileSync(dashboardPath, "utf8")) as {
  panels: Array<{ targets?: Array<{ expr: string }> }>;
};

/** Every `daveio_*` series named in a panel query. */
function queriedMetrics(): string[] {
  const names = new Set<string>();
  for (const panel of dashboard.panels) {
    for (const target of panel.targets ?? []) {
      for (const match of target.expr.matchAll(/\bdaveio_[a-z_]+\b/g)) {
        // Histograms are queried through their generated series.
        names.add(match[0].replace(/_(bucket|count|sum)$/, ""));
      }
    }
  }
  return [...names];
}

describe("the Grafana dashboard", () => {
  it("queries metrics at all", () => {
    expect(queriedMetrics().length).toBeGreaterThan(8);
  });

  it("names only metrics this service exposes", async () => {
    const exposed = new Set((await registry.getMetricsAsJSON()).map((m) => m.name));
    const missing = queriedMetrics().filter((name) => !exposed.has(name));
    expect(
      missing,
      "the dashboard queries metrics that do not exist - a renamed metric leaves a panel showing No data",
    ).toEqual([]);
  });

  it("graphs the counter that makes ungrounded answers visible", () => {
    // Named explicitly rather than left to the general check: this is the one
    // panel whose absence would hide a regression in grounding (ADR-006).
    expect(queriedMetrics()).toContain("daveio_agent_unsupported_citations_total");
  });

  it("is embedded in the ConfigMap byte for byte", () => {
    const yaml = readFileSync(configMapPath, "utf8");
    const embedded = yaml.split("daveio-api.json: |\n", 2)[1];
    expect(embedded, "the ConfigMap has no embedded dashboard").toBeTruthy();
    const unindented = embedded!
      .split("\n")
      .map((line) => (line.startsWith("    ") ? line.slice(4) : line))
      .join("\n")
      .trim();
    // Compared as parsed objects: whitespace differences are not drift, and a
    // byte comparison would fail on a trailing newline nobody can see.
    expect(JSON.parse(unindented)).toEqual(dashboard);
  });
});
