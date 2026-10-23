import { describe, expect, it } from "vitest";
import { GLOBAL_SERVICES, RESOURCE_KINDS, SCANNABLE_SERVICES } from "@sightline/shared";

import { COLLECTORS, declaredGlobal } from "./registry.js";

/** Nodes the pipeline makes itself rather than reading from AWS. */
const SYNTHETIC = new Set(["Account", "Region", "Internet"]);

describe("the collector registry", () => {
  it("scopes each service the way the shared list does", () => {
    // The UI and the unit rows read GLOBAL_SERVICES; the runner reads the
    // plugin. Disagreeing, a global service would be planned once per region.
    expect([...declaredGlobal()].sort()).toEqual([...GLOBAL_SERVICES].sort());
    expect(Object.keys(COLLECTORS).sort()).toEqual([...SCANNABLE_SERVICES].sort());
  });

  it("has exactly one producer for every kind that comes from AWS", () => {
    const producers = new Map<string, string[]>();
    for (const [service, plugin] of Object.entries(COLLECTORS)) {
      for (const kind of plugin.kinds) {
        producers.set(kind, [...(producers.get(kind) ?? []), service]);
      }
    }
    for (const kind of RESOURCE_KINDS.filter((k) => !SYNTHETIC.has(k))) {
      expect(producers.get(kind), `nothing collects ${kind}`).toHaveLength(1);
    }
  });

  it("names the permissions a refused call needs", () => {
    for (const [service, plugin] of Object.entries(COLLECTORS)) {
      expect(plugin.permissions.length, `${service} lists no permissions`).toBeGreaterThan(0);
    }
  });
});
