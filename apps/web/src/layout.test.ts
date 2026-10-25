/**
 * The graph's layout, held to what the reader relies on, so that replacing the
 * layout library (dagre, then its maintained fork) cannot change it unnoticed.
 */

import { describe, expect, it } from "vitest";
import type { Edge, Node } from "@xyflow/react";

import { layoutGraph } from "./layout.js";

const node = (id: string): Node => ({ id, position: { x: 0, y: 0 }, data: {} });
const edge = (source: string, target: string): Edge => ({
  id: `${source}-${target}`,
  source,
  target,
});

describe("layoutGraph", () => {
  it("runs left to right: the internet first, what it reaches after", () => {
    const [internet, lb, db] = layoutGraph(
      [node("internet"), node("lb"), node("db")],
      [edge("internet", "lb"), edge("lb", "db")],
    );
    expect(internet!.position.x).toBeLessThan(lb!.position.x);
    expect(lb!.position.x).toBeLessThan(db!.position.x);
  });

  it("does not stack siblings on one another", () => {
    const placed = layoutGraph(
      [node("internet"), node("a"), node("b")],
      [edge("internet", "a"), edge("internet", "b")],
    );
    const [a, b] = [placed[1]!, placed[2]!];
    expect(a.position.x).toBe(b.position.x);
    expect(Math.abs(a.position.y - b.position.y)).toBeGreaterThanOrEqual(46);
  });

  it("ignores an edge to a node a filter has hidden, rather than throwing", () => {
    expect(() => layoutGraph([node("a")], [edge("a", "hidden")])).not.toThrow();
  });
});
