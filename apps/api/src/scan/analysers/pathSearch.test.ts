import type { Relationship } from "@sightline/shared";
import { describe, expect, it } from "vitest";

import { indexReach, searchPaths } from "./reachIndex.js";

const edge = (from: string, to: string): Relationship => ({
  from,
  to,
  type: "CAN_REACH",
  properties: { ports: ["tcp/443"] },
});

/** Layers of `width` nodes, each linked to every node in the next: width^layers paths. */
function layered(width: number, layers: number): Relationship[] {
  const edges: Relationship[] = [];
  const layer = (i: number) => Array.from({ length: width }, (_, n) => `L${i}-${n}`);
  for (const n of layer(0)) edges.push(edge("src", n));
  for (let i = 0; i < layers - 1; i++) {
    for (const a of layer(i)) for (const b of layer(i + 1)) edges.push(edge(a, b));
  }
  for (const n of layer(layers - 1)) edges.push(edge(n, "dst"));
  return edges;
}

const bounds = { maxPaths: 2000, budgetMs: 2000 };

describe("searchPaths", () => {
  it("finds every path when there are few", () => {
    const { found, stopped } = searchPaths(indexReach(layered(2, 2)), "src", "dst", 5, bounds);
    expect(found).toHaveLength(4);
    expect(stopped).toBeNull();
  });

  it("stops at the path cap on a dense graph, and says so", () => {
    // 10^4 = 10,000 paths of length 5.
    const { found, stopped } = searchPaths(indexReach(layered(10, 4)), "src", "dst", 5, bounds);
    expect(found).toHaveLength(2000);
    expect(stopped).toBe("paths");
  });

  it("stops when the time runs out, and says so", () => {
    let clock = 0;
    const { stopped } = searchPaths(indexReach(layered(10, 4)), "src", "dst", 5, {
      maxPaths: 1_000_000,
      budgetMs: 10,
      now: () => (clock += 1),
    });
    expect(stopped).toBe("time");
  });

  it("follows nothing that cannot arrive within the hop limit", () => {
    const { found } = searchPaths(indexReach(layered(3, 4)), "src", "dst", 4, bounds);
    expect(found).toEqual([]);
  });
});
