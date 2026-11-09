/**
 * The default here is a measurement, not a taste: ap-southeast-1 completes its
 * TCP handshake in ~290ms from Europe, and Node's 250ms default abandoned it
 * mid-connect. Anything back under that round trip reinstates the bug, so the
 * floor is asserted rather than left to a reviewer to notice.
 */

import net from "node:net";

import { describe, expect, it } from "vitest";

import { cfg } from "./config.js";
import { configureEgress } from "./egress.js";

describe("configureEgress", () => {
  it("gives a connect attempt longer than Node's 250ms default", () => {
    expect(cfg.NET_CONNECT_ATTEMPT_TIMEOUT_MS).toBeGreaterThanOrEqual(1000);

    const before = net.getDefaultAutoSelectFamilyAttemptTimeout();
    try {
      configureEgress();
      expect(net.getDefaultAutoSelectFamilyAttemptTimeout()).toBe(
        cfg.NET_CONNECT_ATTEMPT_TIMEOUT_MS,
      );
    } finally {
      net.setDefaultAutoSelectFamilyAttemptTimeout(before);
    }
  });

  it("leaves family selection to the host, which may have working IPv6", () => {
    configureEgress();
    expect(net.getDefaultAutoSelectFamily()).toBe(true);
  });
});
