/**
 * Does a subnet's network ACL let the internet in on a port, and the answer out?
 *
 * ACLs are stateless and ordered: the lowest-numbered rule that matches
 * decides, and nothing matching is a deny. So reaching a host from the
 * internet needs an inbound allow on the port *and* an outbound allow on the
 * ephemeral range the reply leaves from.
 *
 * Evaluated for an arbitrary internet address, which only a rule covering all
 * of `0.0.0.0/0` (or `::/0`) is certain to match. An allow for one specific
 * range is a path from that range alone, and is not reported as exposure to
 * the internet.
 */

export interface NaclEntry {
  ruleNumber: number | null;
  egress: boolean;
  action: string | null;
  protocol: string | null;
  cidr: string | null;
  fromPort: number | null;
  toPort: number | null;
}

export interface TrafficSpec {
  /** `tcp`, `udp`, `icmp` or `-1` for all, as security group rules spell it. */
  protocol: string;
  fromPort: number | null;
  toPort: number | null;
}

/** ACLs number protocols; security groups name them. */
const PROTOCOL_NUMBER: Record<string, string> = { tcp: "6", udp: "17", icmp: "1", "-1": "-1" };

const EVERYWHERE = new Set(["0.0.0.0/0", "::/0"]);

/** The reply's source ports. Linux uses 32768-60999; AWS's guidance is 1024-65535. */
const EPHEMERAL: TrafficSpec = { protocol: "tcp", fromPort: 1024, toPort: 65535 };

function protocolMatches(entry: NaclEntry, protocol: string): boolean {
  if (entry.protocol === "-1") return true;
  return entry.protocol === (PROTOCOL_NUMBER[protocol] ?? protocol);
}

/** Whether the entry covers every port the traffic might use. */
function portsMatch(entry: NaclEntry, traffic: TrafficSpec): boolean {
  if (entry.protocol === "-1" || entry.fromPort === null || entry.toPort === null) return true;
  const from = traffic.fromPort ?? 0;
  const to = traffic.toPort ?? 65535;
  return entry.fromPort <= from && entry.toPort >= to;
}

/** The first applicable rule's verdict for an arbitrary internet address. */
export function decide(
  entries: NaclEntry[],
  egress: boolean,
  traffic: TrafficSpec,
): { allowed: boolean; ruleNumber: number | null } {
  const ordered = entries
    .filter((e) => e.egress === egress)
    .sort((a, b) => (a.ruleNumber ?? 32767) - (b.ruleNumber ?? 32767));
  for (const entry of ordered) {
    if (!entry.cidr || !EVERYWHERE.has(entry.cidr)) continue;
    if (!protocolMatches(entry, traffic.protocol)) continue;
    if (!portsMatch(entry, traffic)) continue;
    return { allowed: entry.action === "allow", ruleNumber: entry.ruleNumber };
  }
  return { allowed: false, ruleNumber: null };
}

/**
 * Null when the ACL lets the traffic in and the reply out, otherwise why not.
 * The reason names the rule, so the finding can be checked against the console.
 */
export function blockedByNacl(entries: NaclEntry[], traffic: TrafficSpec): string | null {
  const inbound = decide(entries, false, traffic);
  if (!inbound.allowed) {
    return inbound.ruleNumber === null
      ? "no inbound rule allows it, so the default deny applies"
      : `inbound rule ${inbound.ruleNumber} denies it`;
  }
  // A reply is TCP or UDP on an ephemeral port; ICMP and all-protocol rules
  // need no separate return path to be judged here.
  if (traffic.protocol === "tcp" || traffic.protocol === "udp") {
    const outbound = decide(entries, true, { ...EPHEMERAL, protocol: traffic.protocol });
    if (!outbound.allowed) {
      return outbound.ruleNumber === null
        ? "no outbound rule lets the reply leave on ephemeral ports"
        : `outbound rule ${outbound.ruleNumber} drops the reply on ephemeral ports`;
    }
  }
  return null;
}
