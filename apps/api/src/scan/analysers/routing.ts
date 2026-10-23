/**
 * Whether traffic from one subnet gets to another, by the route tables.
 *
 * A rule admitting `10.1.0.0/16` admits nothing unless that range can route
 * here and the replies can route back. In one VPC the local route does; across
 * VPCs it takes an active peering or a transit gateway, a route on both sides,
 * and for a TGW a route in the table the sender's attachment is associated with.
 * Longest prefix wins, and a blackhole matches and drops rather than falling
 * through. IPv4 only; `::/0` stays with the internet edges.
 */

import type { Resource } from "@sightline/shared";

import type { FlatRoute } from "../collectors/routes.js";
import type { TgwAttachment, TgwRoute } from "../collectors/connectivity.js";

interface Cidr {
  base: number;
  bits: number;
}

export function parseCidr(text: unknown): Cidr | null {
  if (typeof text !== "string") return null;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  const octets = match.slice(1, 5).map(Number);
  const bits = match[5] === undefined ? 32 : Number(match[5]);
  if (octets.some((o) => o > 255) || bits > 32) return null;
  const ip = octets.reduce((acc, o) => ((acc << 8) | o) >>> 0, 0);
  return { base: (ip & mask(bits)) >>> 0, bits };
}

const mask = (bits: number) => (bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0);

/** Whether every address in `inner` is in `outer`. */
export function cidrContains(outer: Cidr, inner: Cidr): boolean {
  return inner.bits >= outer.bits && (inner.base & mask(outer.bits)) >>> 0 === outer.base;
}

export const cidrOverlaps = (a: Cidr, b: Cidr) => cidrContains(a, b) || cidrContains(b, a);

export interface SubnetRoutes {
  arn: string;
  name: string;
  vpcId: string;
  cidr: Cidr;
  routes: FlatRoute[];
}

interface Tgw {
  id: string;
  name: string;
  byVpc: Map<string, TgwAttachment>;
  tables: Map<string, TgwRoute[]>;
}

/** The most specific route whose destination covers all of `to`, if any. */
function longestMatch<R extends { destination: string | null }>(routes: R[], to: Cidr) {
  let best: { route: R; bits: number } | null = null;
  for (const route of routes) {
    const dest = parseCidr(route.destination);
    if (dest && cidrContains(dest, to) && (!best || dest.bits > best.bits)) {
      best = { route, bits: dest.bits };
    }
  }
  return best?.route;
}

export class RoutingModel {
  readonly subnets = new Map<string, SubnetRoutes>();
  readonly subnetsByVpc = new Map<string, SubnetRoutes[]>();
  private readonly peerings = new Map<string, { name: string; vpcs: [string, string] }>();
  private readonly tgws = new Map<string, Tgw>();

  constructor(resources: Resource[]) {
    const tables = new Map<string, FlatRoute[]>();
    for (const r of resources) {
      const p = r.properties;
      if (r.kind === "RouteTable" && typeof p["routeTableId"] === "string") {
        tables.set(p["routeTableId"], (p["routes"] ?? []) as FlatRoute[]);
      } else if (r.kind === "VpcPeeringConnection" && p["active"] === true) {
        const a = (p["requester"] as { vpcId?: string } | undefined)?.vpcId;
        const b = (p["accepter"] as { vpcId?: string } | undefined)?.vpcId;
        if (a && b) this.peerings.set(String(p["peeringId"]), { name: r.name, vpcs: [a, b] });
      } else if (r.kind === "TransitGateway") {
        const byVpc = new Map<string, TgwAttachment>();
        for (const a of (p["attachments"] ?? []) as TgwAttachment[]) {
          if (a.vpcId && a.state === "available") byVpc.set(a.vpcId, a);
        }
        const routeTables = (p["routeTables"] ?? []) as {
          routeTableId: string;
          routes: TgwRoute[];
        }[];
        this.tgws.set(String(p["transitGatewayId"]), {
          id: String(p["transitGatewayId"]),
          name: r.name,
          byVpc,
          tables: new Map(routeTables.map((t) => [t.routeTableId, t.routes])),
        });
      }
    }
    for (const r of resources) {
      if (r.kind !== "Subnet") continue;
      const cidr = parseCidr(r.properties["cidrBlock"]);
      const vpcId = r.properties["vpcId"];
      if (!cidr || typeof vpcId !== "string") continue;
      const subnet: SubnetRoutes = {
        arn: r.arn,
        name: r.name,
        vpcId,
        cidr,
        routes: tables.get(String(r.properties["routeTableId"])) ?? [],
      };
      this.subnets.set(r.arn, subnet);
      const list = this.subnetsByVpc.get(vpcId) ?? [];
      list.push(subnet);
      this.subnetsByVpc.set(vpcId, list);
    }
  }

  /** VPCs this one might exchange traffic with: itself, its peers, its TGW neighbours. */
  connectedVpcs(vpcId: string): Set<string> {
    const out = new Set([vpcId]);
    for (const { vpcs } of this.peerings.values()) {
      if (vpcs[0] === vpcId) out.add(vpcs[1]);
      if (vpcs[1] === vpcId) out.add(vpcs[0]);
    }
    for (const tgw of this.tgws.values()) {
      if (tgw.byVpc.has(vpcId)) for (const other of tgw.byVpc.keys()) out.add(other);
    }
    return out;
  }

  /** How `from` sends traffic to `to`, or null if its routes do not. */
  private route(from: SubnetRoutes, to: SubnetRoutes): string | null {
    const best = longestMatch(from.routes, to.cidr);
    if (!best || best.state === "blackhole") return null;
    switch (best.targetType) {
      case "local":
        return from.vpcId === to.vpcId ? "local" : null;
      case "peering": {
        const pcx = best.targetId ? this.peerings.get(best.targetId) : undefined;
        if (!pcx?.vpcs.includes(from.vpcId) || !pcx.vpcs.includes(to.vpcId)) return null;
        return `peering ${pcx.name}`;
      }
      case "transit-gateway": {
        const tgw = best.targetId ? this.tgws.get(best.targetId) : undefined;
        const sending = tgw?.byVpc.get(from.vpcId);
        const receiving = tgw?.byVpc.get(to.vpcId);
        if (!tgw || !sending?.routeTableId || !receiving) return null;
        const hop = longestMatch(tgw.tables.get(sending.routeTableId) ?? [], to.cidr);
        if (hop?.state !== "active") return null;
        // Empty when the API did not name the attachment; the destination
        // being attached at all is then the most that can be checked.
        if (hop.attachmentIds.length > 0 && !hop.attachmentIds.includes(receiving.attachmentId)) {
          return null;
        }
        return `transit gateway ${tgw.name}`;
      }
      default:
        return null;
    }
  }

  /**
   * Null when no route joins them either way; otherwise how they are joined,
   * "" inside one VPC. Both directions, because a connection whose replies
   * cannot get back is not a connection.
   */
  pathBetween(from: SubnetRoutes, to: SubnetRoutes): string | null {
    const there = this.route(from, to);
    const back = there && this.route(to, from);
    if (!there || !back) return null;
    return there === "local" ? "" : `over ${there}, with a route back over ${back}`;
  }
}
