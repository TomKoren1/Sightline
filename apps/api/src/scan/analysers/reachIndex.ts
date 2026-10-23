/**
 * Walking `CAN_REACH` without materialising every pair.
 *
 * A rule admitting a security group is stored once, as an edge from that
 * *group* to the target, not once per member: a default group shared by N
 * instances would otherwise be N² edges. So a resource's next hops are its own
 * edges plus those of every group it belongs to, worked out when asked, and
 * paths still run resource to resource. A rule admitting a subnet's range is
 * stored as an edge from the subnet, and expands to its members the same way.
 */

import type { Relationship } from "@sightline/shared";

/** One hop: where it goes, and every rule edge that justifies it. */
export interface ReachHop {
  to: string;
  edges: Relationship[];
}

export interface ReachIndex {
  /** Hops out of a resource, merged per target. Never includes itself. */
  next(arn: string): ReachHop[];
  /** Resources with a hop into this one. */
  prev(arn: string): string[];
}

const push = <K, V>(map: Map<K, V[]>, key: K, value: V) =>
  (map.get(key) ?? map.set(key, []).get(key)!).push(value);

export function indexReach(relationships: Iterable<Relationship>): ReachIndex {
  const out = new Map<string, Relationship[]>();
  const into = new Map<string, string[]>();
  const groupsOf = new Map<string, string[]>();
  const membersOf = new Map<string, string[]>();

  for (const rel of relationships) {
    if (rel.type === "CAN_REACH") {
      push(out, rel.from, rel);
      push(into, rel.to, rel.from);
    } else if (rel.type === "HAS_SECURITY_GROUP" || rel.type === "IN_SUBNET") {
      push(groupsOf, rel.from, rel.to);
      push(membersOf, rel.to, rel.from);
    }
  }

  return {
    next(arn) {
      const merged = new Map<string, Relationship[]>();
      for (const source of [arn, ...(groupsOf.get(arn) ?? [])]) {
        for (const edge of out.get(source) ?? []) {
          if (edge.to !== arn) push(merged, edge.to, edge);
        }
      }
      return [...merged].map(([to, edges]) => ({ to, edges }));
    },
    prev(arn) {
      const sources = new Set<string>();
      for (const from of into.get(arn) ?? []) {
        // A group's edge stands for every member of it.
        const members = membersOf.get(from);
        for (const source of members ?? [from]) if (source !== arn) sources.add(source);
      }
      return [...sources];
    },
  };
}

/** Everything reachable from `start`, with the fewest hops to each. */
export function hopsFrom(
  index: ReachIndex,
  start: string,
  maxHops = Infinity,
): Map<string, number> {
  const hops = new Map<string, number>([[start, 0]]);
  for (let frontier = [start], d = 1; frontier.length > 0 && d <= maxHops; d++) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const { to } of index.next(node)) {
        if (!hops.has(to)) {
          hops.set(to, d);
          next.push(to);
        }
      }
    }
    frontier = next;
  }
  return hops;
}
