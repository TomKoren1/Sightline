/**
 * AWS Resource Explorer, used as an optional fast path.
 *
 * Resource Explorer is suggested for pulling a bulk inventory across
 * services and regions in a few calls, and on a large real account it is the
 * right first move. Two things constrain how far it can be taken:
 *
 *  1. **It returns identity, not configuration.** A search result carries an
 *     ARN, a type, a region and tags. It does not carry a security group's
 *     rules, a bucket's policy, or an RDS instance's subnet group - which are
 *     exactly the fields every question in this project depends on. So it
 *     cannot replace the collectors; the detailed Describe calls still happen.
 *
 *  2. **It needs an index the customer has to create.** Resource Explorer
 *     requires a local index per region plus one aggregator index, and a
 *     read-only role cannot create either. On an account that has not enabled
 *     it, this path is simply unavailable no matter what we do.
 *
 * What it *is* used for here: narrowing the scan plan. On an account with 30
 * enabled regions and resources in four of them, one Search call tells us which
 * four, and the other 26 regions are skipped instead of costing six Describe
 * calls each. That is the difference between 180 scan units and 30.
 *
 * Every failure mode degrades to "fast path unavailable", never to an error:
 * missing index, missing permission, unsupported region, or a mock that does
 * not implement the service at all (see engineering log #4).
 */

import { ListIndexesCommand, paginateSearch } from "@aws-sdk/client-resource-explorer-2";

import { cfg } from "../config.js";
import { resourceExplorerClient } from "./clients.js";

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
    const message = err instanceof Error ? err.message : String(err);

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
