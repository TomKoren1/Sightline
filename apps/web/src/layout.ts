/**
 * Graph layout.
 *
 * Dagre, left-to-right, so that reachability reads the way people expect:
 * the internet on the left, the things it can touch to its right, and the
 * database at the end of the chain. A force layout looks livelier and makes
 * that relationship much harder to see.
 */

import dagre from "dagre";
import type { Edge, Node } from "@xyflow/react";

const NODE_WIDTH = 190;
const NODE_HEIGHT = 46;

export function layoutGraph(nodes: Node[], edges: Edge[]): Node[] {
  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({
    rankdir: "LR",
    nodesep: 24,
    ranksep: 110,
    marginx: 40,
    marginy: 40,
  });

  for (const node of nodes) {
    graph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const edge of edges) {
    // Dagre throws if an edge names a node it was not given, which happens
    // whenever a filter hides one endpoint.
    if (graph.hasNode(edge.source) && graph.hasNode(edge.target)) {
      graph.setEdge(edge.source, edge.target);
    }
  }

  dagre.layout(graph);

  return nodes.map((node) => {
    const positioned = graph.node(node.id);
    return {
      ...node,
      position: positioned
        ? { x: positioned.x - NODE_WIDTH / 2, y: positioned.y - NODE_HEIGHT / 2 }
        : { x: 0, y: 0 },
    };
  });
}
