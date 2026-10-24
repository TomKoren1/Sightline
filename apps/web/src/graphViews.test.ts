import { describe, expect, it } from "vitest";

import type { GraphData } from "./api.js";
import { mergeGraphs } from "./graphViews.js";

const view = (arns: string[], edges: [string, string][], total = arns.length): GraphData => ({
  nodes: arns.map((arn) => ({ arn, kind: "Ec2Instance", name: arn, region: null })),
  edges: edges.map(([from, to]) => ({ from, to, type: "CAN_REACH" })),
  total,
  truncated: total > arns.length,
});

describe("mergeGraphs", () => {
  it("joins a group and expanded neighbourhoods, each node and edge once", () => {
    const merged = mergeGraphs([
      view(["a", "b"], [["a", "b"]], 900),
      view(
        ["b", "c"],
        [
          ["a", "b"],
          ["b", "c"],
        ],
      ),
      undefined,
    ]);
    expect(merged.nodes.map((n) => n.arn)).toEqual(["a", "b", "c"]);
    expect(merged.edges).toHaveLength(2);
    expect(merged).toMatchObject({ truncated: true, total: 900 });
  });
});
