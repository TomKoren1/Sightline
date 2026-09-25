/**
 * Resource Explorer cannot be exercised against the mock at all — moto does not
 * implement the service (engineering log #4) — and on a real account it needs
 * an index a read-only role cannot create. So the behaviour that matters is
 * tested here: that narrowing is correct when the index is available, and that
 * every way it can be unavailable degrades to scanning everything rather than
 * to an error.
 */

import { describe, expect, it } from "vitest";
import { narrowRegions, type FastPathResult } from "./resourceExplorer.js";

const available = (regions: string[], count = 100): FastPathResult => ({
  available: true,
  activeRegions: new Set(regions),
  resourceCount: count,
});

const unavailable = (reason = "no index"): FastPathResult => ({
  available: false,
  activeRegions: new Set(),
  resourceCount: 0,
  unavailableReason: reason,
});

const ALL = ["us-east-1", "eu-west-1", "ap-southeast-1", "sa-east-1", "eu-north-1"];

describe("narrowRegions", () => {
  it("skips regions the index says hold nothing", () => {
    const { regions, skipped } = narrowRegions(
      ALL,
      available(["us-east-1", "eu-west-1"]),
      "us-east-1",
    );
    expect(regions).toEqual(["us-east-1", "eu-west-1"]);
    expect(skipped).toEqual(["ap-southeast-1", "sa-east-1", "eu-north-1"]);
  });

  /**
   * Global services (IAM, the S3 bucket namespace) are read through the home
   * region's endpoint. Dropping it because it happens to hold no regional
   * resources would silently skip them.
   */
  it("always keeps the home region, even when the index reports nothing there", () => {
    const { regions } = narrowRegions(ALL, available(["eu-west-1"]), "us-east-1");
    expect(regions).toContain("us-east-1");
    expect(regions).toContain("eu-west-1");
  });

  it("scans everything when the fast path is unavailable", () => {
    const { regions, skipped } = narrowRegions(ALL, unavailable(), "us-east-1");
    expect(regions).toEqual(ALL);
    expect(skipped).toEqual([]);
  });

  /**
   * An index that disagrees with reality this badly is not worth trusting -
   * better a slow complete scan than a fast empty one.
   */
  it("falls back to everything rather than narrowing to nothing", () => {
    const { regions, skipped } = narrowRegions(
      ["eu-west-2", "eu-west-3"],
      available(["us-east-1"]),
      "us-east-1",
    );
    expect(regions).toEqual(["eu-west-2", "eu-west-3"]);
    expect(skipped).toEqual([]);
  });

  it("ignores active regions that were never in scope", () => {
    const { regions } = narrowRegions(
      ["us-east-1", "eu-west-1"],
      available(["us-east-1", "eu-west-1", "ap-northeast-1"]),
      "us-east-1",
    );
    expect(regions).toEqual(["us-east-1", "eu-west-1"]);
  });

  it("is a no-op when every configured region is active", () => {
    const { regions, skipped } = narrowRegions(ALL, available(ALL), "us-east-1");
    expect(regions).toEqual(ALL);
    expect(skipped).toEqual([]);
  });
});
