/**
 * Network reachability.
 *
 * Turns security group rules into a walkable graph, so that "what can reach
 * the production database?" becomes a path query instead of an exercise in
 * reading rules by hand.
 *
 * Two kinds of edge are produced:
 *
 *   Internet -> resource   when a security group on that resource admits
 *                          0.0.0.0/0 AND the resource is actually exposed -
 *                          in a public subnet, holding a public address, or
 *                          flagged publicly accessible. An open rule on an
 *                          instance buried in a private subnet does not make
 *                          it reachable, and saying otherwise would bury the
 *                          real findings in noise.
 *
 *   resource -> resource   when the target's security group admits a group
 *                          that the source belongs to. This is the edge that
 *                          makes multi-hop paths visible.
 *
 * What this deliberately does not model: network ACLs, route tables between
 * subnets, VPC peering, Transit Gateway, PrivateLink, and on-premises
 * connectivity. Each would add edges, so the analysis is conservative: it can
 * miss a path, but a path it reports is justified by rules that really exist.
 * Every edge carries the rule that produced it, so any claim can be checked.
 */

import { INTERNET_ARN, type Relationship, type Resource } from "@daveio/shared";
import { formatPortRange } from "@daveio/shared";

/** An ingress rule, flattened by the VPC collector. */
interface IngressRule {
  protocol: string;
  fromPort: number | null;
  toPort: number | null;
  source: "cidr" | "securityGroup";
  cidr?: string;
  groupId?: string;
  description?: string | null;
}

const OPEN_CIDRS = new Set(["0.0.0.0/0", "::/0"]);

export interface ReachabilityResult {
  edges: Relationship[];
  /** ARNs reachable from the internet, directly or transitively. */
  internetReachable: Set<string>;
}

export function analyseReachability(
  resources: Resource[],
  relationships: Relationship[],
): ReachabilityResult {
  const byArn = new Map(resources.map((r) => [r.arn, r]));

  // Security groups, indexed by the group id that rules refer to.
  const sgArnByGroupId = new Map<string, string>();
  for (const r of resources) {
    if (r.kind !== "SecurityGroup") continue;
    const groupId = r.properties["groupId"];
    if (typeof groupId === "string") sgArnByGroupId.set(groupId, r.arn);
  }

  // resource -> the security groups attached to it, and the inverse.
  const sgsOfResource = new Map<string, string[]>();
  const membersOfSg = new Map<string, string[]>();
  for (const rel of relationships) {
    if (rel.type !== "HAS_SECURITY_GROUP") continue;
    (sgsOfResource.get(rel.from) ?? sgsOfResource.set(rel.from, []).get(rel.from)!).push(rel.to);
    (membersOfSg.get(rel.to) ?? membersOfSg.set(rel.to, []).get(rel.to)!).push(rel.from);
  }

  // resource -> subnet, so we can tell whether it sits on the public side.
  const subnetOfResource = new Map<string, string>();
  for (const rel of relationships) {
    if (rel.type === "IN_SUBNET") subnetOfResource.set(rel.from, rel.to);
  }

  /** Is this resource actually exposed, independent of its rules? */
  function exposure(resource: Resource): string | null {
    const subnetArn = subnetOfResource.get(resource.arn);
    const subnet = subnetArn ? byArn.get(subnetArn) : undefined;
    if (subnet?.derived.isPublic) {
      return `it sits in public subnet ${subnet.name}`;
    }
    if (typeof resource.properties["publicIpAddress"] === "string") {
      return `it has public IP ${resource.properties["publicIpAddress"]}`;
    }
    if (resource.properties["publiclyAccessible"] === true) {
      return "it is flagged publicly accessible";
    }
    return null;
  }

  const edges: Relationship[] = [];
  const seen = new Set<string>();
  const push = (edge: Relationship) => {
    const key = `${edge.from}|${edge.to}|${JSON.stringify(edge.properties ?? {})}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(edge);
  };

  for (const target of resources) {
    const targetSgs = sgsOfResource.get(target.arn);
    if (!targetSgs || targetSgs.length === 0) continue;

    for (const sgArn of targetSgs) {
      const sg = byArn.get(sgArn);
      if (!sg) continue;
      const rules = (sg.properties["ingress"] ?? []) as IngressRule[];

      for (const rule of rules) {
        const ports = formatPortRange(rule);

        if (rule.source === "cidr" && rule.cidr && OPEN_CIDRS.has(rule.cidr)) {
          const why = exposure(target);
          // An open rule on something that is not exposed is a latent risk,
          // not a live path. Recorded on the group, not as an internet edge.
          if (!why) continue;
          push({
            from: INTERNET_ARN,
            to: target.arn,
            type: "CAN_REACH",
            properties: {
              ports,
              via: sg.name,
              viaArn: sg.arn,
              reason: `Security group ${sg.name} allows ${ports} from ${rule.cidr}, and ${why}`,
            },
          });
          continue;
        }

        if (rule.source === "securityGroup" && rule.groupId) {
          const sourceSgArn = sgArnByGroupId.get(rule.groupId);
          if (!sourceSgArn) continue;
          const sourceSg = byArn.get(sourceSgArn);
          for (const memberArn of membersOfSg.get(sourceSgArn) ?? []) {
            if (memberArn === target.arn) continue;
            const member = byArn.get(memberArn);
            push({
              from: memberArn,
              to: target.arn,
              type: "CAN_REACH",
              properties: {
                ports,
                via: sg.name,
                viaArn: sg.arn,
                reason: `Security group ${sg.name} allows ${ports} from ${sourceSg?.name ?? rule.groupId}, which ${member?.name ?? memberArn} belongs to`,
              },
            });
          }
        }
      }
    }
  }

  return { edges, internetReachable: transitiveFromInternet(edges) };
}

/**
 * Everything reachable from the internet by following CAN_REACH edges.
 *
 * Plain breadth-first search. The visited set makes cycles harmless, which
 * matters because security groups routinely reference each other both ways.
 */
export function transitiveFromInternet(edges: Relationship[]): Set<string> {
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.type !== "CAN_REACH") continue;
    (outgoing.get(edge.from) ?? outgoing.set(edge.from, []).get(edge.from)!).push(edge.to);
  }

  const reachable = new Set<string>();
  const queue = [INTERNET_ARN];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of outgoing.get(current) ?? []) {
      if (reachable.has(next)) continue;
      reachable.add(next);
      queue.push(next);
    }
  }
  return reachable;
}
