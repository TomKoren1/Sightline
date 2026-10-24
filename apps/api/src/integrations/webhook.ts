/**
 * Delivery to a tenant's webhook - Slack's incoming-webhook shape, which
 * Teams, Mattermost and most chat tools also accept.
 *
 * The URL is the tenant's, so this is a request a tenant can aim: at the
 * cloud metadata endpoint, at Postgres, at anything on the cluster network.
 * So: https only, and every address the name resolves to is checked at
 * connect time, inside the socket's own lookup, so a name that resolves
 * public when saved and private when used (DNS rebinding) is still refused.
 * No redirects are followed. Five seconds, one attempt, and the outcome is
 * recorded rather than retried: a notification is not worth a queue.
 */

import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

const BLOCKED = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  BLOCKED.addSubnet(net, bits, "ipv4");
}
// No ::ffff:0:0/96 rule: BlockList checks a mapped address against the IPv4
// rules above already, and that rule would match every IPv4 address.
for (const [net, bits] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  BLOCKED.addSubnet(net, bits, "ipv6");
}

export const isPublicAddress = (address: string): boolean => {
  const family = isIP(address);
  return family !== 0 && !BLOCKED.check(address, family === 6 ? "ipv6" : "ipv4");
};

/** Why a URL cannot be a webhook, or null if it can. Checked when saved, and again at send. */
export function refuseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "That is not a URL.";
  }
  if (url.protocol !== "https:") return "A webhook must be https.";
  if (url.username || url.password) return "Put credentials in the path, not before the host.";
  if (
    isIP(url.hostname.replace(/^\[|\]$/g, "")) &&
    !isPublicAddress(url.hostname.replace(/^\[|\]$/g, ""))
  ) {
    return "That address is private.";
  }
  if (/^(localhost|.*\.local|.*\.internal|.*\.cluster\.local)$/i.test(url.hostname)) {
    return "That host is not on the internet.";
  }
  return null;
}

/** The socket's lookup: refuses the connection if any address is not public. */
export const publicOnly: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    const list = addresses;
    const blocked = list.find((a) => !isPublicAddress(a.address));
    if (blocked || list.length === 0) {
      return callback(
        Object.assign(new Error(`${hostname} resolves to a private address`), { code: "EPRIVATE" }),
        "",
        0,
      );
    }
    if ((options as { all?: boolean }).all) {
      return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
    }
    return callback(null, list[0]!.address, list[0]!.family);
  });
};

export interface Delivery {
  ok: boolean;
  status: string;
}

export function deliver(rawUrl: string, payload: unknown): Promise<Delivery> {
  const refused = refuseUrl(rawUrl);
  if (refused) return Promise.resolve({ ok: false, status: refused });
  const url = new URL(rawUrl);
  const body = JSON.stringify(payload);
  return new Promise((resolve) => {
    const req = request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        lookup: publicOnly,
        timeout: 5000,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "user-agent": "Sightline-Webhook/1",
        },
      },
      (res) => {
        res.resume();
        const code = res.statusCode ?? 0;
        resolve({ ok: code >= 200 && code < 300, status: `HTTP ${code}` });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timed out after 5 s")));
    req.on("error", (err) => resolve({ ok: false, status: err.message.slice(0, 200) }));
    req.end(body);
  });
}
