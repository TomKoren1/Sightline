/**
 * Four artefacts agree about one port number, and nothing publishes it.
 *
 * `config.ts` defaults it, two workloads listen on it, scrape annotations name
 * it, and a NetworkPolicy opens it. Nothing connects those files, and the
 * symptom of disagreement is the worst kind: a Prometheus target that quietly
 * reads `down`, with empty dashboards and no error anywhere.
 *
 * The last assertion is the security one. Metrics are unreachable from the
 * internet because nginx proxies only `/api/`, not because of a guard - so if
 * somebody adds a `location /metrics` later, this is what notices.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (p: string) => readFileSync(root + p, "utf8");

interface Doc {
  kind?: string;
  metadata?: { name?: string; annotations?: Record<string, string> };
  spec?: Record<string, unknown>;
}

function docs(file: string): Doc[] {
  return parseAllDocuments(read(file))
    .map((d) => d.toJS() as Doc | null)
    .filter((d): d is Doc => d !== null && Object.keys(d).length > 0);
}

/** The application's own default, which is the number everything else copies. */
function configuredPort(): number {
  const config = read("apps/api/src/config.ts");
  // Non-greedy across `)`, because the declaration is a chain of calls:
  // `blankAsUnset(z.coerce.number().int().min(0).default(9464))`.
  const match = /METRICS_PORT:[\s\S]{0,160}?default\((\d+)\)/.exec(config);
  expect(match, "config.ts no longer defaults METRICS_PORT").toBeTruthy();
  return Number(match![1]);
}

const app = docs("deploy/k8s/base/app.yaml");
const policies = docs("deploy/k8s/base/networkpolicy.yaml");

const SCRAPED = ["api", "worker"] as const;

describe("the metrics port", () => {
  const port = configuredPort();

  it("was found, along with the manifests that reference it", () => {
    // Without this every assertion below passes on an empty parse.
    expect(port).toBeGreaterThan(0);
    expect(app.length).toBeGreaterThan(4);
    expect(policies.length).toBeGreaterThan(3);
  });

  it("is annotated for scraping on everything that serves it", () => {
    const annotated: string[] = [];
    for (const doc of app) {
      const onService = doc.kind === "Service" ? doc.metadata?.annotations : undefined;
      const template = (
        doc.spec as { template?: { metadata?: { annotations?: Record<string, string> } } }
      )?.template;
      const annotations = onService ?? template?.metadata?.annotations;
      if (annotations?.["prometheus.io/scrape"] !== "true") continue;

      annotated.push(doc.metadata?.name ?? "unnamed");
      expect(annotations["prometheus.io/port"], `${doc.metadata?.name} scrape port`).toBe(
        String(port),
      );
      expect(annotations["prometheus.io/path"]).toBe("/metrics");
    }

    // Both of them: the api through its Service, the worker through its pods,
    // because the worker has no Service to annotate.
    for (const name of SCRAPED) {
      expect(annotated, `${name} is not annotated for scraping`).toContain(name);
    }
  });

  it("is a named container port on both workloads", () => {
    for (const name of SCRAPED) {
      const workload = app.find(
        (d) => ["Deployment", "StatefulSet"].includes(d.kind ?? "") && d.metadata?.name === name,
      );
      expect(workload, `no workload named ${name}`).toBeTruthy();

      const containers =
        (
          workload!.spec as {
            template?: {
              spec?: { containers?: { ports?: { name?: string; containerPort?: number }[] }[] };
            };
          }
        ).template?.spec?.containers ?? [];
      const metricsPorts = containers
        .flatMap((c) => c.ports ?? [])
        .filter((p) => p.name === "metrics")
        .map((p) => p.containerPort);

      expect(metricsPorts, `${name} does not listen on a port named metrics`).toEqual([port]);
    }
  });

  it("is the only port the monitoring namespace may reach", () => {
    const policy = policies.find((p) => p.metadata?.name === "metrics-from-monitoring-only");
    expect(policy, "the scrape policy is gone, so Prometheus cannot reach the port").toBeTruthy();

    const spec = policy!.spec as {
      podSelector?: { matchExpressions?: { key: string; values?: string[] }[] };
      ingress?: {
        from?: { namespaceSelector?: { matchLabels?: Record<string, string> } }[];
        ports?: { port?: number }[];
      }[];
    };

    // Both workloads, and only the metrics port.
    const selected = (spec.podSelector?.matchExpressions ?? []).flatMap((e) => e.values ?? []);
    for (const name of SCRAPED) expect(selected).toContain(name);

    const opened = (spec.ingress ?? []).flatMap((rule) => rule.ports ?? []).map((p) => p.port);
    expect(opened, "the policy must open the metrics port and nothing else").toEqual([port]);

    // From one namespace, not from the whole cluster.
    const namespaces = (spec.ingress ?? [])
      .flatMap((rule) => rule.from ?? [])
      .flatMap((from) => Object.values(from.namespaceSelector?.matchLabels ?? {}));
    expect(namespaces).toContain("monitoring");
  });

  it("is not published through the tunnel", () => {
    /**
     * The claim that metrics are unreachable from the internet rests on nginx
     * proxying `/api/` and nothing else. If a `location` for metrics appears,
     * that claim quietly stops being true - which is the kind of change that
     * looks harmless in a diff.
     */
    const nginx = read("deploy/nginx.conf");
    const locations = [...nginx.matchAll(/location\s+([^\s{]+)/g)].map((m) => m[1]);
    expect(locations.length).toBeGreaterThan(1);
    expect(
      locations.filter((l) => l?.includes("metrics")),
      "nginx must not route the metrics port: it is behind the Cloudflare tunnel, and the " +
        "whole point of a separate port is that it cannot be reached from outside.",
    ).toEqual([]);
    expect(nginx).not.toContain(String(port));
  });
});
