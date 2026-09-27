/**
 * Region discovery.
 *
 * A real customer account has regions enabled that we cannot guess, and
 * regions disabled that would waste an API call each. `DescribeRegions` with
 * `AllRegions: false` returns exactly the ones this account can actually use,
 * including opt-in regions the customer has enabled.
 */

import { DescribeRegionsCommand } from "@aws-sdk/client-ec2";
import { ec2Client } from "./clients.js";
import { cfg, configuredRegions } from "../config.js";
import type { TenantId } from "../tenancy/tenant.js";

/**
 * Regions to scan.
 *
 * An explicit list wins, because on a real account you usually want to bound
 * a scan. With no list configured we ask AWS, and fall back to the home region
 * if even that fails - a scan of one region beats no scan at all.
 */
export async function resolveRegions(
  tenantId: TenantId,
  endpoint: string | null = null,
): Promise<{ regions: string[]; discovered: boolean }> {
  const configured = configuredRegions();
  if (configured && configured.length > 0) {
    return { regions: configured, discovered: false };
  }

  try {
    const client = ec2Client(cfg.AWS_REGION, tenantId, endpoint);
    const res = await client.send(new DescribeRegionsCommand({ AllRegions: false }));
    const regions = (res.Regions ?? [])
      .map((r) => r.RegionName)
      .filter((r): r is string => Boolean(r))
      .sort();
    if (regions.length > 0) return { regions, discovered: true };
  } catch (err) {
    console.warn(
      `Region discovery failed, falling back to ${cfg.AWS_REGION}:`,
      err instanceof Error ? err.message : err,
    );
  }

  return { regions: [cfg.AWS_REGION], discovered: false };
}
