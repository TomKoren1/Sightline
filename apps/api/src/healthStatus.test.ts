/**
 * `degraded` has to mean something that should work does not.
 *
 * The LLM key is documented as optional — the scan, the graph, the findings and the
 * whole tier-1 eval suite run without it. Folding it into the overall status meant a
 * fresh clone reported `degraded` with both databases healthy: a fault indicator on
 * the first thing a new reader looks at, contradicting the README that had just told
 * them the key was optional.
 *
 * The rule is asserted here rather than left implicit in the route, because "which
 * checks make the service unhealthy" is a product decision and the kind of thing
 * that gets widened by accident.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(fileURLToPath(new URL("./app.ts", import.meta.url)), "utf8");

/** Mirrors the route's rule, so the cases below describe real behaviour. */
function overallStatus(checks: Record<string, string>): "ok" | "degraded" {
  const required = ["postgres", "neo4j"] as const;
  return required.every((key) => checks[key] === "ok") ? "ok" : "degraded";
}

describe("health status", () => {
  it("is ok when the databases are healthy but the agent has no key", () => {
    expect(
      overallStatus({
        postgres: "ok",
        neo4j: "ok",
        agent: "ANTHROPIC_API_KEY not set - chat will fail",
      }),
    ).toBe("ok");
  });

  it("is degraded when a database is down, key or no key", () => {
    for (const agent of ["configured (claude-sonnet-5)", "ANTHROPIC_API_KEY not set"]) {
      expect(overallStatus({ postgres: "ok", neo4j: "connection refused", agent })).toBe(
        "degraded",
      );
      expect(overallStatus({ postgres: "timeout", neo4j: "ok", agent })).toBe("degraded");
    }
  });

  it("does not let a new optional check silently make the service unhealthy", () => {
    // Adding a check must be a deliberate decision about whether it is required.
    expect(overallStatus({ postgres: "ok", neo4j: "ok", somethingNew: "not configured" })).toBe(
      "ok",
    );
  });

  it("keeps the route's required list to the two databases", () => {
    /**
     * Pins the route to the rule above. Without this the mirror could drift from
     * the implementation and these cases would describe nothing.
     */
    const match = /const required = \[([^\]]*)\] as const;/.exec(source);
    expect(match, "the required-checks list was renamed or restructured").toBeTruthy();
    // [a-z0-9]: "neo4j" has a digit in it, and [a-z]+ silently matched nothing.
    const keys = [...match![1]!.matchAll(/"([a-z0-9]+)"/g)].map((m) => m[1]);
    expect(keys.sort()).toEqual(["neo4j", "postgres"]);
  });

  it("still reports the agent check, so nothing is hidden", () => {
    expect(source).toContain('checks["agent"]');
    // And still names the file it looked in, which is the part that was actively
    // misleading when it was missing (engineering log #36).
    expect(source).toContain("no .env found at");
  });
});
