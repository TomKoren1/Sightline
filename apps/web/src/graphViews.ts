/**
 * How the graph is shown for a large account: a group, or neighbourhoods,
 * at a time, merged into one view.
 */

import type { GraphData } from "./api.js";

/** Above this many resources, the graph opens on its groups. */
export const LARGE_ACCOUNT = 400;
export const FOCUS = "focus";

/** Several views of the graph as one: nodes by ARN, edges once each. */
export function mergeGraphs(parts: (GraphData | undefined)[]): Pick<
  GraphData,
  "nodes" | "edges"
> & {
  truncated: boolean;
  total: number;
} {
  const nodes = new Map<string, GraphData["nodes"][number]>();
  const edges = new Map<string, GraphData["edges"][number]>();
  let truncated = false;
  let total = 0;
  for (const part of parts) {
    if (!part) continue;
    for (const n of part.nodes) nodes.set(n.arn, n);
    for (const e of part.edges) edges.set(`${e.from}|${e.type}|${e.to}`, e);
    truncated ||= part.truncated;
    total = Math.max(total, part.total);
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()], truncated, total };
}
