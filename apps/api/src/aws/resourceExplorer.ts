/**
 * AWS Resource Explorer, as an optional fast path. Two limits:
 *
 *  1. **It returns identity, not configuration** - ARN, type, region, tags, but
 *     not a security group's rules or a bucket's policy, which is what every
 *     question here depends on. It cannot replace the collectors.
 *  2. **It needs an index the customer must create,** and a read-only role
 *     cannot create one. On an account without it this path is unavailable.
 *
 * So it is used only to narrow the scan plan: one Search tells us which four of
 * 30 enabled regions hold resources, which is 30 scan units instead of 180.
 *
 * Every failure degrades to "fast path unavailable", never to an error -
 * including a mock that does not implement the service (engineering log #4).
 */

import { ListIndexesCommand, paginateSearch } from "@aws-sdk/client-resource-explorer-2";

import { cfg } from "../config.js";
import { resourceExplorerClient } from "./clients.js";
import { errorMessage } from "@sightline/shared";

export interface FastPathResult {
  /** Whether an aggregator index was found and searched successfully. */
  available: boolean;
  /** Regions observed to contain at least one resource. Empty when unavailable. */
  activeRegions: Set<string>;
  /** Total resources the index reported, for reporting and cross-checking. */
  resourceCount: number;
  /** Why the fast path was not used, when it was not. */
  unavailableReason?: string;
}

/**
 * The aggregator index is the only one that can answer a cross-region query.
 * A local index only sees its own region, so finding one is not enough.
 */
async function findAggregatorRegion(): Promise<string | null> {
  const client = resourceExplorerClient(cfg.AWS_REGION);
  const res = await client.send(new ListIndexesCommand({ Type: "AGGREGATOR" }));
  const index = (res.Indexes ?? []).find((i) => i.Type === "AGGREGATOR" && i.Region);
  return index?.Region ?? null;
}

/**
 * Ask Resource Explorer which regions hold resources.
 *
 * Bounded deliberately: this is an optimisation, and an optimisation that takes
 * longer than the work it saves is not one. If an account is large enough that
 * paging the whole index is slow, the region set has almost certainly converged
 * long before the end.
 */
export async function discoverActiveRegions(maxPages = 20): Promise<FastPathResult> {
  const unavailable = (reason: string): FastPathResult => ({
    available: false,
    activeRegions: new Set(),
    resourceCount: 0,
    unavailableReason: reason,
  });

  try {
    const aggregatorRegion = await findAggregatorRegion();
    if (!aggregatorRegion) {
      return unavailable("no aggregator index in this account, using per-service enumeration");
    }

    const client = resourceExplorerClient(aggregatorRegion);
    const activeRegions = new Set<string>();
    let resourceCount = 0;
    let pages = 0;

    for await (const page of paginateSearch({ client }, { QueryString: "*" })) {
      for (const resource of page.Resources ?? []) {
        resourceCount++;
        if (resource.Region) activeRegions.add(resource.Region);
      }
      if (++pages >= maxPages) break;
    }

    if (activeRegions.size === 0) {
      return unavailable("aggregator index returned nothing, not trusting it to narrow the scan");
    }

    return { available: true, activeRegions, resourceCount };
  } catch (err) {
    // Every failure here is expected on some real account: no index, no
    // permission, service not available in the partition, or a mock that does
    // not implement it. None is worth failing a scan over.
    const name = err instanceof Error ? err.name : "UnknownError";
    const message = errorMessage(err);

    // An endpoint that answers HTML rather than JSON is not implementing the
    // service at all. Reporting that as a JSON parse error is technically true
    // and tells the reader nothing, and this is printed on every scan against
    // the mock.
    if (name === "SyntaxError" || message.includes("<!doctype") || message.includes("<html")) {
      return unavailable(
        "endpoint does not implement Resource Explorer, using per-service enumeration",
      );
    }
    if (name === "AccessDeniedException" || name === "UnauthorizedException") {
      return unavailable(
        "not permitted to read Resource Explorer (resource-explorer-2:ListIndexes), using per-service enumeration",
      );
    }
    return unavailable(
      `unavailable (${name}: ${message.slice(0, 120)}), using per-service enumeration`,
    );
  }
}

/**
 * Narrow a region list to those known to hold resources.
 *
 * The home region is always kept: it is where global services are read from,
 * and dropping it would skip IAM and S3 entirely.
 */
export function narrowRegions(
  configured: string[],
  fastPath: FastPathResult,
  homeRegion: string,
): { regions: string[]; skipped: string[] } {
  if (!fastPath.available) return { regions: configured, skipped: [] };

  const keep = configured.filter((r) => fastPath.activeRegions.has(r) || r === homeRegion);
  const skipped = configured.filter((r) => !keep.includes(r));

  // If narrowing would eliminate everything, the index disagrees with reality
  // badly enough that it should not be trusted.
  if (keep.length === 0) return { regions: configured, skipped: [] };

  return { regions: keep, skipped };
}
