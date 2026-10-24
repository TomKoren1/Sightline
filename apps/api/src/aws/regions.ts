/**
 * Region discovery.
 *
 * A real customer account has regions enabled that we cannot guess, and
 * regions disabled that would waste an API call each. `DescribeRegions` with
 * `AllRegions: false` returns exactly the ones this account can actually use,
 * including opt-in regions the customer has enabled.
 */

import { DescribeRegionsCommand } from "@aws-sdk/client-ec2";
import { ec2Client, type AwsContext } from "./clients.js";
import { cfg } from "../core/config.js";
import { configuredRegions } from "./settings.js";
import { errorMessage } from "@sightline/shared";

/**
 * Regions to scan.
 *
 * An explicit list wins, because on a real account you usually want to bound
 * a scan. With no list configured we ask AWS, and fall back to the home region
 * if even that fails - a scan of one region beats no scan at all.
 */
export async function resolveRegions(
  ctx: AwsContext,
  configuredForTarget: string[] | null,
): Promise<{ regions: string[]; discovered: boolean }> {
  // The connection's own list wins over the process default: on a hosted
  // service there is no single configured region set to speak of.
  const configured = configuredForTarget ?? configuredRegions();
  if (configured && configured.length > 0) {
    return { regions: configured, discovered: false };
  }

  try {
    const client = ec2Client(ctx, cfg.AWS_REGION);
    const res = await client.send(new DescribeRegionsCommand({ AllRegions: false }));
    const regions = (res.Regions ?? [])
      .map((r) => r.RegionName)
      .filter((r): r is string => Boolean(r))
      .sort();
    if (regions.length > 0) return { regions, discovered: true };
  } catch (err) {
    console.warn(`Region discovery failed, falling back to ${cfg.AWS_REGION}:`, errorMessage(err));
  }

  return { regions: [cfg.AWS_REGION], discovered: false };
}
