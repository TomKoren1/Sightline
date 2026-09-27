/**
 * Invariants the Helm chart has to hold.
 *
 * A chart is YAML nobody runs until a deploy, and the mistakes it can make are
 * the expensive kind: a redirect URI that does not match Google, an endpoint
 * override that would redirect signed AWS calls, a scrape annotation missing
 * so the dashboard is empty when it matters.
 *
 * Read as text rather than rendered with `helm template`, because CI has no
 * helm binary and the properties worth guarding are all visible in the source.
 * `helm lint` covers the rest locally.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const chartDir = fileURLToPath(new URL("../../../../helm/daveio/", import.meta.url));
const templates = readdirSync(`${chartDir}templates`).filter(
  (f) => f.endsWith(".yaml") || f.endsWith(".tpl"),
);
const allTemplates = templates
  .map((f) => readFileSync(`${chartDir}templates/${f}`, "utf8"))
  .join("\n");
const values = readFileSync(`${chartDir}values.yaml`, "utf8");

describe("the chart", () => {
  it("has templates to check", () => {
    // Without this every assertion below passes against an empty string.
    expect(templates.length).toBeGreaterThan(5);
    expect(allTemplates.length).toBeGreaterThan(2000);
  });

  /**
   * The one that would be a security bug rather than an outage: an SDK-wide
   * endpoint override redirects every signed call the process makes,
   * including ones made with credentials assumed inside a customer's account
   * (ADR-015).
   */
  it("never sets AWS_ENDPOINT_URL", () => {
    const offenders = templates.filter((f) =>
      /name:\s*AWS_ENDPOINT_URL/.test(readFileSync(`${chartDir}templates/${f}`, "utf8")),
    );
    expect(
      offenders,
      "the demo account uses DEMO_AWS_ENDPOINT_URL, which applies only to tenants who asked for it",
    ).toEqual([]);
  });

  it("points the demo at the in-cluster mock, not at anything external", () => {
    expect(allTemplates).toContain("DEMO_AWS_ENDPOINT_URL");
    expect(allTemplates).toMatch(/DEMO_AWS_ENDPOINT_URL[\s\S]{0,120}-moto:5000/);
  });

  it("deploys in hosted mode", () => {
    expect(values).toMatch(/deploymentMode:\s*hosted/);
  });

  /** A trailing slash here is `redirect_uri_mismatch` with no useful message. */
  it("configures a public base URL that can match a Google redirect URI", () => {
    const match = /publicBaseUrl:\s*(\S+)/.exec(values);
    expect(match).toBeTruthy();
    expect(match![1]).toMatch(/^https:\/\/[^/]+$/);
  });

  it("takes every secret from a Secret, never from values", () => {
    const secretNames = [
      "SESSION_SECRET",
      "GOOGLE_CLIENT_SECRET",
      "AWS_SECRET_ACCESS_KEY",
      "POSTGRES_PASSWORD",
    ];
    for (const name of secretNames) {
      expect(allTemplates, `${name} should come from secretKeyRef`).toMatch(
        new RegExp(`name:\\s*${name}[\\s\\S]{0,120}secretKeyRef`),
      );
      expect(values, `${name} must not appear in values.yaml`).not.toContain(name);
    }
  });

  it("lets Prometheus find the API", () => {
    expect(allTemplates).toContain("prometheus.io/scrape");
    expect(allTemplates).toContain('prometheus.io/path: "/metrics"');
  });

  /**
   * Google redirects a browser to /auth/google/callback, and that exact path
   * is registered with Google - so the ingress has to route it to the API,
   * not to the frontend, which would serve an HTML page to an OAuth callback.
   */
  it("routes /auth to the API, not the frontend", () => {
    const ingress = readFileSync(`${chartDir}templates/ingress.yaml`, "utf8");
    expect(ingress).toMatch(/path:\s*\/auth[\s\S]{0,200}-api/);
  });

  it("runs one worker, and replaces rather than overlaps", () => {
    const worker = readFileSync(`${chartDir}templates/worker-deployment.yaml`, "utf8");
    expect(worker).toMatch(/replicas:\s*1/);
    expect(worker).toMatch(/type:\s*Recreate/);
  });

  it("ships no real secret values", () => {
    // The placeholder is deliberate; a real value here would be committed
    // base64, which gitleaks would fail the build over - correctly.
    const secrets = readFileSync(`${chartDir}templates/secrets-sealedsecret.yaml`, "utf8");
    expect(secrets).toContain("REPLACE-WITH-SEALEDSECRET");
    expect(secrets).not.toMatch(/AKIA[A-Z0-9]{16}/);
    expect(secrets).not.toMatch(/GOCSPX-/);
  });
});
