/**
 * Dashboards and alerts may only reference metrics the application registers.
 *
 * A panel querying nothing renders an empty graph for ever and an alert on a
 * metric nobody exports can never fire. Both look healthy: "no data" is
 * indistinguishable from "nothing is wrong".
 *
 * Names come from `metrics.ts`, so a rename breaks this rather than quietly
 * emptying a panel. The dashboards sit in `deploy/k8s/base/` with the
 * application, not in the chart - the sidecar finds them by label in any
 * namespace, so they travel with what they describe.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (p: string) => readFileSync(root + p, "utf8");

/** Every metric the application registers, from its definitions. */
function registeredMetrics(): Set<string> {
  const source = read("apps/api/src/observability/metrics.ts");
  const names = [...source.matchAll(/^\s+name: "([a-z_0-9]+)",$/gm)].map((m) => m[1]!);
  expect(names.length, "no metric names found in metrics.ts").toBeGreaterThan(20);
  return new Set(names);
}

/**
 * Metrics Prometheus itself provides, which the application cannot register.
 *
 * Node process metrics from `collectDefaultMetrics`, the scrape-health series,
 * kube-state-metrics, cAdvisor, node-exporter, and the two pushed by the
 * backup CronJob - which is a shell script, not this registry.
 */
const EXTERNAL = [
  "up",
  "time",
  "process_",
  "nodejs_",
  "kube_",
  "container_",
  "node_",
  "argocd_",
  "sightline_backup_",
  "resume_generation_",
  "ALERTS",
];

const isExternal = (name: string) => EXTERNAL.some((p) => name === p || name.startsWith(p));

/** Bare metric names out of a PromQL expression, without parsing PromQL. */
function metricsIn(expr: string): string[] {
  // Identifiers not immediately preceded by `(` or followed by `(`, which
  // excludes function names like `rate(` and `sum by (le)`.
  const found = new Set<string>();
  for (const m of expr.matchAll(/\b([a-z_][a-z_0-9]*)\b\s*(\(|\{|\[|\)|\s|$)/g)) {
    const name = m[1]!;
    if (m[2] === "(") continue; // a function
    found.add(name);
  }
  return [...found];
}

/** Suffixes Prometheus appends to a histogram, which are not separate metrics. */
const stripSuffix = (name: string) => name.replace(/_(bucket|count|sum)$/, "");

/** Words that look like metrics in PromQL but are keywords or labels. */
const KEYWORDS = new Set([
  "by",
  "on",
  "without",
  "and",
  "or",
  "unless",
  "le",
  "ignoring",
  "group_left",
  "group_right",
  "offset",
  "bool",
  "start",
  "end",
  "status",
  "route",
  "service",
  "region",
  "reason",
  "outcome",
  "kind",
  "tool",
  "app",
  "namespace",
  "pod",
  "container",
  "version",
  "commit",
  "mode",
  "resource",
  "fstype",
  "mountpoint",
  "quantile",
  "job",
  "instance",
  "name",
  "health_status",
  "level",
  "msg",
]);

describe("the monitoring chart", () => {
  const metrics = registeredMetrics();
  const dashboardDir = `${root}deploy/k8s/base/dashboards`;
  const dashboards = readdirSync(dashboardDir).filter((f) => f.endsWith(".json"));

  it("has dashboards and a rules file to check", () => {
    // Without this the whole file passes against a chart that is not there.
    expect(dashboards.length).toBeGreaterThan(3);
    expect(existsSync(`${root}helm/monitoring/values.yaml`)).toBe(true);
    expect(existsSync(`${root}helm/monitoring/Chart.yaml`)).toBe(true);
  });

  it("ships those dashboards with the application, not with the chart", () => {
    /**
     * The chart is the platform and nothing else, which is what lets either
     * copy of it be the active one without carrying another repository's
     * panels. If a dashboard appears in the chart, that stops being true.
     */
    expect(existsSync(`${root}helm/monitoring/dashboards`)).toBe(false);

    const kustomization = read("deploy/k8s/base/kustomization.yaml");
    for (const file of dashboards) {
      expect(kustomization, `${file} is not generated into a ConfigMap`).toContain(file);
    }
    // The label the sidecar looks for, and no name hash - a hashed name on
    // every edit leaves two copies of the dashboard in Grafana.
    expect(kustomization).toContain('grafana_dashboard: "1"');
    expect(kustomization).toContain("disableNameSuffixHash: true");
  });

  it("has dashboards that parse, with unique ids", () => {
    const uids = new Set<string>();
    for (const file of dashboards) {
      const doc = JSON.parse(readFileSync(`${dashboardDir}/${file}`, "utf8")) as {
        uid?: string;
        title?: string;
        panels?: { title?: string; description?: string }[];
      };
      expect(doc.uid, `${file} has no uid`).toBeTruthy();
      expect(uids.has(doc.uid!), `${file} reuses uid ${doc.uid}`).toBe(false);
      uids.add(doc.uid!);
      expect(doc.panels?.length, `${file} has no panels`).toBeGreaterThan(0);

      // A panel whose title is the only explanation is a panel nobody can
      // interpret at 2am. Grafana shows `description` on hover.
      const undescribed = (doc.panels ?? [])
        .filter((p) => !p.description && p.title)
        .map((p) => `${file}: ${p.title}`);
      expect(undescribed, "every panel needs a description").toEqual([]);
    }
  });

  it("references only datasources the chart defines", () => {
    const values = parse(read("helm/monitoring/values.yaml")) as {
      grafana?: { datasources?: Record<string, { datasources?: { uid?: string }[] }> };
    };
    const defined = new Set(
      Object.values(values.grafana?.datasources ?? {})
        .flatMap((d) => d.datasources ?? [])
        .map((d) => d.uid),
    );
    expect(defined.size).toBeGreaterThan(1);

    for (const file of dashboards) {
      const raw = readFileSync(`${dashboardDir}/${file}`, "utf8");
      for (const m of raw.matchAll(/"uid":\s*"([A-Za-z]+)"/g)) {
        // Panel/dashboard uids are lower-case-with-dashes; datasource uids
        // here are capitalised, which is how the two are told apart.
        const uid = m[1]!;
        if (!/^[A-Z]/.test(uid)) continue;
        expect(
          defined,
          `${file} uses datasource ${uid}, which the chart does not define`,
        ).toContain(uid);
      }
    }
  });

  it("queries only metrics the application registers", () => {
    const unknown = new Set<string>();

    const check = (expr: string, where: string) => {
      for (const raw of metricsIn(expr)) {
        const name = stripSuffix(raw);
        if (KEYWORDS.has(name) || isExternal(name)) continue;
        // Only our own namespace: Loki queries and label names are not metrics.
        if (!name.startsWith("sightline_") && !name.startsWith("http_")) continue;
        if (!metrics.has(name)) unknown.add(`${name} (${where})`);
      }
    };

    for (const file of dashboards) {
      const doc = JSON.parse(readFileSync(`${dashboardDir}/${file}`, "utf8")) as {
        panels?: { targets?: { expr?: string }[] }[];
      };
      for (const p of doc.panels ?? []) {
        for (const t of p.targets ?? []) if (t.expr) check(t.expr, file);
      }
    }

    const values = parse(read("helm/monitoring/values.yaml")) as {
      prometheus?: {
        serverFiles?: { "alerting_rules.yml"?: { groups?: { rules?: { expr?: string }[] }[] } };
      };
    };
    const groups = values.prometheus?.serverFiles?.["alerting_rules.yml"]?.groups ?? [];
    expect(groups.length).toBeGreaterThan(2);
    for (const group of groups) {
      for (const rule of group.rules ?? []) if (rule.expr) check(rule.expr, "alerting_rules.yml");
    }

    expect(
      [...unknown],
      "these are queried by a dashboard or an alert and registered by nothing. A panel renders " +
        "an empty graph for ever and an alert can never fire, and both look healthy - 'no data' " +
        "is indistinguishable from 'nothing is wrong'.",
    ).toEqual([]);
  });

  it("pins the same dependency versions as the other copy of this chart", () => {
    /**
     * Two complete copies exist, in two repositories, and exactly one is
     * deployed. The inactive one is code nobody runs, so the only thing
     * stopping it drifting into something that has never worked is that the
     * pins match.
     *
     * Skipped when that repository is not checked out - this runs in CI too -
     * with the assertion above acting as the floor so a skip cannot pass for
     * the wrong reason.
     */
    const other = "/home/tom/resume_builder/helm/monitoring/Chart.yaml";
    if (!existsSync(other)) return;

    const pins = (text: string) => {
      const chart = parse(text) as { dependencies?: { name: string; version: string }[] };
      return (chart.dependencies ?? []).map((d) => `${d.name}@${d.version}`).sort();
    };

    const ours = pins(read("helm/monitoring/Chart.yaml"));
    expect(ours.length).toBe(3);
    expect(
      pins(readFileSync(other, "utf8")),
      "the two copies of this chart pin different dependency versions, so whichever is not " +
        "deployed has never been run against these numbers.",
    ).toEqual(ours);
  });
});
