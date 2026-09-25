/**
 * Idle detection, with one regression pinned hard.
 *
 * The Elastic IP rule was written correctly and never fired once. moto reports
 * an unassociated address as `NetworkInterfaceId: ""` and `InstanceId: ""`
 * rather than omitting the keys, the collector passed those through with
 * `?? null` (which only catches `undefined`), and the analyser asked
 * `!== null`. An empty string is not null, so every orphaned address read as
 * associated and no orphaned Elastic IP was ever reported.
 *
 * Nothing failed. The ground-truth answer key had the same omission, so the
 * idle check agreed with the bug (engineering log #30). Hence tests at the
 * value level, where the empty string can be stated explicitly.
 */

import { describe, expect, it } from "vitest";
import type { Resource } from "@daveio/shared";

import { analyseIdleResources } from "./idle.js";

function elasticIp(properties: Record<string, unknown>): Resource {
  return {
    arn: "arn:aws:ec2:us-east-1:123456789012:elastic-ip/eipalloc-1",
    kind: "ElasticIp",
    name: "203.0.113.7",
    region: "us-east-1",
    accountId: "123456789012",
    tags: {},
    properties: { allocationId: "eipalloc-1", publicIp: "203.0.113.7", ...properties },
    derived: {},
    raw: {},
  } as Resource;
}

describe("idle Elastic IPs", () => {
  it("flags an address associated with nothing", () => {
    const eip = elasticIp({ associationId: null, instanceId: null, networkInterfaceId: null });
    analyseIdleResources([eip], []);
    expect(eip.derived.isIdle).toBe(true);
    expect(eip.derived.estimatedMonthlyCostUsd).toBeGreaterThan(0);
  });

  /**
   * The exact shape moto returns, and the one that silently defeated this rule.
   * A `!== null` check reads every one of these as "in use".
   */
  it("treats empty strings as unassociated, not as an association", () => {
    const eip = elasticIp({ associationId: null, instanceId: "", networkInterfaceId: "" });
    analyseIdleResources([eip], []);
    expect(eip.derived.isIdle, 'InstanceId: "" means unassociated, so this address is idle').toBe(
      true,
    );
  });

  it("treats whitespace as unassociated too", () => {
    const eip = elasticIp({ associationId: "  ", instanceId: "", networkInterfaceId: "" });
    analyseIdleResources([eip], []);
    expect(eip.derived.isIdle).toBe(true);
  });

  it("does not flag an address attached to an instance", () => {
    const eip = elasticIp({
      associationId: "eipassoc-1",
      instanceId: "i-123",
      networkInterfaceId: "eni-1",
    });
    analyseIdleResources([eip], []);
    expect(eip.derived.isIdle).toBe(false);
  });

  it("does not flag an address attached only to a network interface", () => {
    // How a NAT gateway's address looks: no InstanceId, but genuinely in use.
    const eip = elasticIp({
      associationId: "eipassoc-1",
      instanceId: "",
      networkInterfaceId: "eni-nat",
    });
    analyseIdleResources([eip], []);
    expect(eip.derived.isIdle, "a NAT gateway address is in use").toBe(false);
  });

  it("gives every idle verdict a reason", () => {
    const eip = elasticIp({ associationId: null, instanceId: "", networkInterfaceId: "" });
    analyseIdleResources([eip], []);
    expect(eip.derived.idleReason).toBeTruthy();
  });
});
