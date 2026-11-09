/**
 * Process-wide settings for outbound connections.
 *
 * Node 20 turned happy-eyeballs on by default: a connect to a dual-stack host
 * races both families, giving each address only 250ms. Every AWS endpoint is
 * dual-stack, and a region further away than that - ap-southeast-1 answers in
 * ~290ms from Europe - never finishes its handshake inside a slot, so every
 * attempt is abandoned, the address list runs out, and the connect fails with
 * an `AggregateError` whose `message` is empty. That is the scan unit that
 * reported `Failed to read secretsmanager in ap-southeast-1:` and stopped.
 */

import net from "node:net";

import { cfg } from "./config.js";

/**
 * Widened per attempt rather than pinned to a family: a host with working IPv6
 * still prefers it, and one without still falls through to IPv4 as fast as the
 * network says it can. Call before the first AWS client exists.
 */
export function configureEgress(): void {
  net.setDefaultAutoSelectFamilyAttemptTimeout(cfg.NET_CONNECT_ATTEMPT_TIMEOUT_MS);
}
