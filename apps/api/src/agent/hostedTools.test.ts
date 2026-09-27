/**
 * The raw-Cypher escape hatch, and where it is allowed to exist.
 *
 * `cypherGuard.ts` rejects write clauses and `readQuery` runs inside a read
 * transaction, so `graph_query` cannot change anything. Neither layer knows
 * *whose* data a read touches, which is fine with one tenant and is a
 * cross-tenant read with many (ADR-016).
 *
 * `isHosted()` reads configuration captured when `config.ts` is imported, so
 * these tests re-import the module graph with a different environment rather
 * than mutating a flag - which is also the honest simulation of what actually
 * happens: a process starts in one mode and stays there.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { LOCAL_TENANT } from "../tenancy/tenant.js";

const ORIGINAL = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.resetModules();
});

/** Load the tool module as it would be in a process started this way. */
async function toolsIn(mode: "hosted" | "self-hosted") {
  vi.resetModules();
  process.env["DEPLOYMENT_MODE"] = mode;
  process.env["SECRETS_ALLOW_LOCAL_KEY"] = "true";
  if (mode === "hosted") {
    // Otherwise the hosted invariants would refuse this configuration anyway.
    process.env["AWS_MODE"] = "real";
    process.env["AWS_ENDPOINT_URL"] = "";
    delete process.env["AWS_ACCESS_KEY_ID"];
  }
  return import("./tools.js");
}

describe("the tools a tenant is offered", () => {
  it("excludes graph_query in hosted mode", async () => {
    const { toolDefinitions } = await toolsIn("hosted");
    const names = toolDefinitions().map((t) => t.name);
    expect(names).not.toContain("graph_query");
  });

  it("keeps every other tool, rather than quietly trimming the library", async () => {
    const hosted = (await toolsIn("hosted")).toolDefinitions();
    const self = (await toolsIn("self-hosted")).toolDefinitions();
    expect(self.length - hosted.length).toBe(1);
    expect(self.map((t) => t.name)).toContain("graph_query");
  });

  it("still offers graph_query when self-hosted", async () => {
    const { toolDefinitions } = await toolsIn("self-hosted");
    expect(toolDefinitions().map((t) => t.name)).toContain("graph_query");
  });
});

describe("calling graph_query anyway", () => {
  /**
   * Filtering the list is not the gate. A model can name a tool it was never
   * offered - a replayed conversation, a name that appears in the prompt - so
   * the dispatch refuses it independently.
   */
  it("is refused in hosted mode without touching the database", async () => {
    const { runTool } = await toolsIn("hosted");
    // `ToolInput` is deliberately hostile to construct by hand - the dispatch
    // takes whatever the model sent, which is `unknown` by nature.
    const result = await runTool(
      "graph_query",
      {
        cypher: "MATCH (r:Resource) RETURN r",
      } as unknown as Parameters<typeof runTool>[1],
      LOCAL_TENANT,
    );
    expect(result.rows).toEqual([]);
    expect(result.note).toContain("disabled on the hosted service");
  });
});
