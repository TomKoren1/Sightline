/**
 * A route as the analysers read it: where it sends what, and whether it still
 * works. AWS spreads the target over seven optional fields; this is one.
 */

import type { Route } from "@aws-sdk/client-ec2";

export type RouteTargetType =
  | "local"
  | "internet-gateway"
  | "egress-only-gateway"
  | "nat-gateway"
  | "peering"
  | "transit-gateway"
  | "vpn-gateway"
  | "endpoint"
  | "network-interface"
  | "other";

export interface FlatRoute {
  /** A CIDR, or a prefix list id; null when AWS gave neither. */
  destination: string | null;
  targetType: RouteTargetType;
  targetId: string | null;
  /** `blackhole` once its target is gone: the route matches and drops. */
  state: string;
}

function target(route: Route): [RouteTargetType, string | null] {
  const gateway = route.GatewayId ?? "";
  if (gateway === "local") return ["local", null];
  if (gateway.startsWith("igw-")) return ["internet-gateway", gateway];
  if (gateway.startsWith("vgw-")) return ["vpn-gateway", gateway];
  if (gateway.startsWith("vpce-")) return ["endpoint", gateway];
  if (route.NatGatewayId) return ["nat-gateway", route.NatGatewayId];
  if (route.VpcPeeringConnectionId) return ["peering", route.VpcPeeringConnectionId];
  if (route.TransitGatewayId) return ["transit-gateway", route.TransitGatewayId];
  if (route.EgressOnlyInternetGatewayId) {
    return ["egress-only-gateway", route.EgressOnlyInternetGatewayId];
  }
  if (route.NetworkInterfaceId) return ["network-interface", route.NetworkInterfaceId];
  return ["other", gateway || null];
}

export function flattenRoute(route: Route): FlatRoute {
  const [targetType, targetId] = target(route);
  return {
    destination:
      route.DestinationCidrBlock ??
      route.DestinationIpv6CidrBlock ??
      route.DestinationPrefixListId ??
      null,
    targetType,
    targetId,
    state: route.State ?? "active",
  };
}

/** The active default route to an internet gateway, which is what makes a subnet public. */
export function internetRoute(routes: FlatRoute[]): FlatRoute | undefined {
  return routes.find(
    (r) =>
      (r.destination === "0.0.0.0/0" || r.destination === "::/0") &&
      r.targetType === "internet-gateway" &&
      r.state !== "blackhole",
  );
}
