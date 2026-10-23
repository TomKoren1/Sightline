/**
 * Network reachability: security group rules as a walkable graph, so "what can
 * reach the production database?" is a path query rather than manual reading.
 *
 *   Internet -> resource   a group admits 0.0.0.0/0 AND the resource is
 *                          actually exposed (public subnet, public address, or
 *                          flagged accessible). An open rule on an instance in
 *                          a private subnet would otherwise bury real findings.
 *   group -> resource      the target's group admits the source group, so every
 *                          member reaches it. Stored per group, not per member
 *                          pair, which keeps a shared group linear.
 *
 * Not modelled: NACLs, route tables, VPC peering, Transit Gateway, PrivateLink,
 * on-premises. Each would add edges, so this is conservative - it can miss a
 * path, but a path it reports is justified by rules that exist, and every edge
 * carries the rule that produced it.
 */

import { INTERNET_ARN, type Relationship, type Resource } from "@sightline/shared";
import { formatPortRange } from "@sightline/shared";

import { hopsFrom, indexReach } from "./reachIndex.js";

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
  for (const rel of relationships) {
    if (rel.type !== "HAS_SECURITY_GROUP") continue;
    (sgsOfResource.get(rel.from) ?? sgsOfResource.set(rel.from, []).get(rel.from)!).push(rel.to);
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
          // From the source *group*, not each member: see reachIndex.ts.
          push({
            from: sourceSgArn,
            to: target.arn,
            type: "CAN_REACH",
            properties: {
              ports,
              via: sg.name,
              viaArn: sg.arn,
              sourceGroup: sourceSg?.name ?? rule.groupId,
              reason: `Security group ${sg.name} allows ${ports} from members of ${sourceSg?.name ?? rule.groupId}`,
            },
          });
        }
      }
    }
  }

  const index = indexReach([...relationships, ...edges]);
  const reachable = hopsFrom(index, INTERNET_ARN);
  reachable.delete(INTERNET_ARN);
  return { edges, internetReachable: new Set(reachable.keys()) };
}
