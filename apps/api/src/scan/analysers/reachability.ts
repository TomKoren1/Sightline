/**
 * Network reachability: rules as a walkable graph, so "what can reach the
 * production database?" is a path query rather than manual reading.
 *
 *   Internet -> host     an open rule, on a host that is actually exposed (public
 *                        subnet or address), whose subnet ACL lets it in and out
 *   group -> resource    the target's group admits a group: one edge per group,
 *                        not per member pair, so a shared group stays linear
 *   Internet -> entry    an internet-facing load balancer, an enabled CloudFront
 *                        distribution, an API that is not private
 *   entry -> backend     a load balancer to registered targets whose group admits
 *                        it; a distribution to its origins; an API to what it calls
 *
 * Not modelled: peering, Transit Gateway, PrivateLink, on-premises. A missed
 * path is possible; a reported one is justified by rules that exist.
 */

import { INTERNET_ARN, type Relationship, type Resource } from "@sightline/shared";
import { formatPortRange } from "@sightline/shared";

import { blockedByNacl, type NaclEntry, type TrafficSpec } from "./nacl.js";
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

const push = <K, V>(map: Map<K, V[]>, key: K, value: V) =>
  (map.get(key) ?? map.set(key, []).get(key)!).push(value);

/** Whether a rule admits TCP on this port. */
function admitsPort(rule: IngressRule, port: number | null): boolean {
  if (rule.protocol === "-1") return true;
  if (rule.protocol !== "tcp" && rule.protocol !== "6") return false;
  if (port === null || rule.fromPort === null || rule.toPort === null) return true;
  return rule.fromPort <= port && rule.toPort >= port;
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

  const sgsOfResource = new Map<string, string[]>();
  // A load balancer sits in several subnets; everything else in one.
  const subnetsOfResource = new Map<string, string[]>();
  const naclOfSubnet = new Map<string, NaclEntry[]>();
  const outgoing = new Map<string, Relationship[]>();
  for (const rel of relationships) {
    if (rel.type === "HAS_SECURITY_GROUP") push(sgsOfResource, rel.from, rel.to);
    else if (rel.type === "IN_SUBNET") push(subnetsOfResource, rel.from, rel.to);
    else if (rel.type === "HAS_NACL") {
      const acl = byArn.get(rel.to);
      if (acl) naclOfSubnet.set(rel.from, (acl.properties["entries"] ?? []) as NaclEntry[]);
    }
    push(outgoing, rel.from, rel);
  }
  const outOf = (arn: string, type: Relationship["type"]) =>
    (outgoing.get(arn) ?? []).filter((r) => r.type === type);

  const rulesOf = (arn: string): { sg: Resource; rule: IngressRule }[] =>
    (sgsOfResource.get(arn) ?? []).flatMap((sgArn) => {
      const sg = byArn.get(sgArn);
      if (!sg) return [];
      return ((sg.properties["ingress"] ?? []) as IngressRule[]).map((rule) => ({ sg, rule }));
    });

  /** Is this resource actually exposed, independent of its rules? */
  function exposure(resource: Resource): string | null {
    if (resource.kind === "EcsService") {
      // A task in a public subnet still has no address to reach unless the
      // service gives it one.
      if (resource.properties["assignPublicIp"] !== true) return null;
    }
    if (resource.kind === "LoadBalancer") {
      // Its subnets are public either way; the scheme is what decides.
      return resource.properties["internetFacing"] === true
        ? `it is an internet-facing load balancer`
        : null;
    }
    for (const subnetArn of subnetsOfResource.get(resource.arn) ?? []) {
      const subnet = byArn.get(subnetArn);
      if (subnet?.derived.isPublic) return `it sits in public subnet ${subnet.name}`;
    }
    if (typeof resource.properties["publicIpAddress"] === "string") {
      return `it has public IP ${resource.properties["publicIpAddress"]}`;
    }
    if (resource.properties["publiclyAccessible"] === true) {
      return "it is flagged publicly accessible";
    }
    return null;
  }

  /**
   * Null if some subnet the resource sits in lets this traffic in from the
   * internet and back out, otherwise why none does. A subnet with no ACL
   * recorded uses its VPC's default, which allows everything.
   */
  function naclBlock(arn: string, traffic: TrafficSpec): string | null {
    const subnets = subnetsOfResource.get(arn) ?? [];
    if (subnets.length === 0) return null;
    const reasons: string[] = [];
    for (const subnetArn of subnets) {
      const entries = naclOfSubnet.get(subnetArn);
      if (!entries) return null;
      const blocked = blockedByNacl(entries, traffic);
      if (!blocked) return null;
      reasons.push(`the network ACL on ${byArn.get(subnetArn)?.name ?? subnetArn}: ${blocked}`);
    }
    return reasons.join("; ");
  }

  const edges: Relationship[] = [];
  const seen = new Set<string>();
  const add = (edge: Relationship) => {
    const key = `${edge.from}|${edge.to}|${JSON.stringify(edge.properties ?? {})}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(edge);
  };

  // --- Security group rules -------------------------------------------------
  for (const target of resources) {
    for (const { sg, rule } of rulesOf(target.arn)) {
      const ports = formatPortRange(rule);

      if (rule.source === "cidr" && rule.cidr && OPEN_CIDRS.has(rule.cidr)) {
        const why = exposure(target);
        // An open rule on something that is not exposed is a latent risk,
        // not a live path. Recorded on the group, not as an internet edge.
        if (!why) continue;
        // Open in the group, dropped by the subnet: no path either.
        if (naclBlock(target.arn, rule)) continue;
        add({
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
        add({
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

  // --- Entry points ---------------------------------------------------------
  for (const entry of resources) {
    if (entry.kind === "LoadBalancer") loadBalancerEdges(entry);

    if (entry.kind === "EksCluster" && entry.properties["endpointPublicAccess"] === true) {
      const cidrs = (entry.properties["publicAccessCidrs"] ?? []) as string[];
      // An empty list is AWS's default, which is everywhere.
      const open = cidrs.length === 0 || cidrs.some((c) => OPEN_CIDRS.has(c));
      if (open) {
        add({
          from: INTERNET_ARN,
          to: entry.arn,
          type: "CAN_REACH",
          properties: {
            ports: "tcp/443",
            via: entry.name,
            reason: `EKS cluster ${entry.name} has a public API endpoint open to 0.0.0.0/0`,
          },
        });
      }
    }

    if (entry.kind === "CloudFrontDistribution" && entry.properties["enabled"] === true) {
      add({
        from: INTERNET_ARN,
        to: entry.arn,
        type: "CAN_REACH",
        properties: {
          ports: "tcp/443",
          via: entry.name,
          reason: `CloudFront distribution ${entry.name} serves anyone on the internet`,
        },
      });
    }

    if (entry.kind === "ApiGateway" && entry.properties["isPrivate"] !== true) {
      const endpointType = entry.properties["endpointType"];
      const endpoint = typeof endpointType === "string" ? endpointType.toLowerCase() : "public";
      add({
        from: INTERNET_ARN,
        to: entry.arn,
        type: "CAN_REACH",
        properties: {
          ports: "tcp/443",
          via: entry.name,
          reason: `API ${entry.name} has a ${endpoint} endpoint anyone can call`,
        },
      });
    }

    if (entry.kind === "CloudFrontDistribution" || entry.kind === "ApiGateway") {
      for (const link of [
        ...outOf(entry.arn, "HAS_ORIGIN"),
        ...outOf(entry.arn, "INTEGRATES_WITH"),
      ]) {
        const backend = byArn.get(link.to);
        if (!backend) continue;
        add({
          from: entry.arn,
          to: backend.arn,
          type: "CAN_REACH",
          properties: {
            ports: "tcp/443",
            via: entry.name,
            reason:
              link.type === "HAS_ORIGIN"
                ? `${backend.name} is an origin of CloudFront distribution ${entry.name}`
                : `API ${entry.name} invokes ${backend.name}`,
          },
        });
      }
    }
  }

  function loadBalancerEdges(lb: Resource) {
    const listeners = (lb.properties["listeners"] ?? []) as { port: number | null }[];
    const lbGroupIds = new Set(
      (sgsOfResource.get(lb.arn) ?? []).map((a) => byArn.get(a)?.properties["groupId"]),
    );

    // A network load balancer with no security group admits whatever its
    // listeners accept; one with groups was handled with the rules above.
    if (exposure(lb) && lbGroupIds.size === 0) {
      for (const listener of listeners) {
        const traffic = { protocol: "tcp", fromPort: listener.port, toPort: listener.port };
        if (naclBlock(lb.arn, traffic)) continue;
        add({
          from: INTERNET_ARN,
          to: lb.arn,
          type: "CAN_REACH",
          properties: {
            ports: `tcp/${listener.port}`,
            via: lb.name,
            reason: `${lb.name} is an internet-facing load balancer with no security group, listening on ${listener.port}`,
          },
        });
      }
    }

    // To the targets its listeners forward to, where the targets' groups
    // admit it on the target port. Registered is not reachable.
    for (const forward of outOf(lb.arn, "FORWARDS_TO")) {
      const group = byArn.get(forward.to);
      if (!group) continue;
      const groupPort = (group.properties["port"] as number | null) ?? null;
      for (const registered of outOf(group.arn, "TARGETS")) {
        const target = byArn.get(registered.to);
        if (!target) continue;
        const port = (registered.properties?.["port"] as number | null) ?? groupPort;
        let because: string | null = null;
        if (target.kind === "LambdaFunction") {
          because = `invokes ${target.name}`;
        } else {
          const admit = rulesOf(target.arn).find(
            ({ rule }) =>
              admitsPort(rule, port) &&
              ((rule.source === "securityGroup" && lbGroupIds.has(rule.groupId)) ||
                rule.source === "cidr"),
          );
          if (admit) {
            const from =
              admit.rule.source === "cidr" ? admit.rule.cidr : "the load balancer's group";
            because = `forwards port ${port} to ${target.name}, which ${admit.sg.name} admits from ${from}`;
          }
        }
        if (!because) continue;
        add({
          from: lb.arn,
          to: target.arn,
          type: "CAN_REACH",
          properties: {
            ports: port === null ? "target port" : `tcp/${port}`,
            via: group.name,
            reason: `${lb.name} ${because}, through target group ${group.name}`,
          },
        });
      }
    }
  }

  const index = indexReach([...relationships, ...edges]);
  const reachable = hopsFrom(index, INTERNET_ARN);
  reachable.delete(INTERNET_ARN);
  return { edges, internetReachable: new Set(reachable.keys()) };
}
