/**
 * Scan orchestration.
 *
 * The design commitment here is that **a scan does not fail**. It produces a
 * set of per-`(service, region)` outcomes, some of which may have failed, and
 * reports exactly which. A DevOps engineer looking at a half-scanned account
 * needs to know which half is missing; an error page tells them nothing and
 * throws away the work that succeeded.
 *
 * The only thing that can abort a whole scan is failing to assume the role,
 * because without credentials there is nothing to report.
 */

import {
  SCANNABLE_SERVICES,
  rollUpStatus,
  type ScanEvent,
  type ScanResult,
  type ScanUnit,
  errorMessage,
} from "@sightline/shared";

import { cfg, faultInjections } from "../config.js";
import { CallCounter, type AwsContext } from "../aws/clients.js";
import { getSession } from "../aws/credentials.js";
import { accountMismatch } from "../tenancy/connections.js";
import type { ScanTarget } from "../tenancy/scanTarget.js";
import { resolveRegions } from "../aws/regions.js";
import { discoverActiveRegions, narrowRegions } from "../aws/resourceExplorer.js";
import { runWithConcurrency } from "./limiter.js";
import { mergeOutputs, type CollectorOutput } from "./collectors/types.js";
import { COLLECTORS } from "./collectors/registry.js";
import { annotate } from "./pipeline.js";

export interface ScanOptions {
  /** Which account to scan. There is deliberately no default. */
  target: ScanTarget;
  /** Called as units start and finish, so the UI can show live progress. */
  onEvent?: (event: ScanEvent) => void;
  scanId: string;
  /**
   * Counts this scan's AWS calls. Per scan rather than per process, so one
   * tenant's traffic is never reported as another's.
   */
  counter?: CallCounter;
  /** The tenant's other accounts by id, to name them where this one trusts them. */
  knownAccounts?: ReadonlyMap<string, string>;
}

/** Pull a usable error code out of whatever the SDK threw. */
function errorCodeOf(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e.Code ??
    e.name ??
    (e.$metadata?.httpStatusCode ? `HTTP ${e.$metadata.httpStatusCode}` : undefined)
  );
}

/**
 * Explain a failure in terms a DevOps engineer can act on.
 *
 * The raw SDK message for a missing permission is accurate and useless; what
 * the user needs to know is which permission to add.
 */
function explainFailure(
  service: string,
  region: string | null,
  err: unknown,
  permissions: readonly string[],
): string {
  const code = errorCodeOf(err);
  const where = region ? `${service} in ${region}` : service;
  const message = errorMessage(err);

  switch (code) {
    case "UnauthorizedOperation":
    case "AccessDenied":
    case "AccessDeniedException":
      return `Not permitted to read ${where}. The role needs: ${permissions.join(", ")}.`;
    case "Throttling":
    case "ThrottlingException":
    case "RequestLimitExceeded":
      return `Throttled while reading ${where} after exhausting retries. Results for this service and region are incomplete.`;
    case "OptInRequired":
    case "AuthFailure":
      return `${where} is not enabled for this account.`;
    case "UnrecognizedClientException":
    case "InvalidClientTokenId":
      return `Credentials were rejected reading ${where}. The assumed session may have expired.`;
    default:
      return `Failed to read ${where}: ${message}`;
  }
}

/** What collection produced, before any analysis. */
export interface CollectedEstate {
  accountId: string;
  regions: string[];
  units: ScanUnit[];
  collected: CollectorOutput;
  /** Each succeeded unit's own output, for checking collectors against their declarations. */
  unitOutputs: { unit: ScanUnit; output: CollectorOutput }[];
}

export async function runScan(options: ScanOptions): Promise<ScanResult & { units: ScanUnit[] }> {
  const { accountId, regions, units, collected } = await collectEstate(options);
  return { ...annotate(accountId, regions, collected, options.knownAccounts), units };
}

/**
 * Every collector, every region, and nothing else. Separate from `runScan` so
 * the load test can take a real estate's raw shape and multiply it.
 */
export async function collectEstate(options: ScanOptions): Promise<CollectedEstate> {
  const { scanId, onEvent, target } = options;
  const counter = options.counter ?? new CallCounter();
  const ctx: AwsContext = { target, counter };
  const emit = (event: ScanEvent) => onEvent?.(event);

  // Without credentials there is no scan to report on - this is the one
  // genuinely fatal failure.
  const session = await getSession(target);

  /**
   * The account the role actually reached must be the one this connection was
   * verified against.
   *
   * A role ARN edited after verification would otherwise repoint an existing
   * connection, its history and its graph at a different account, and the scan
   * would succeed - filing one account's inventory under another's name. The
   * pin is evidence; the ARN is only a claim.
   */
  const mismatch = accountMismatch(target.pinnedAccountId, session.accountId);
  if (mismatch) throw new Error(mismatch);

  const { regions: candidateRegions } = await resolveRegions(ctx, target.regions);

  /**
   * Optional fast path. One Resource Explorer query can tell us which regions
   * actually hold resources, so the rest are skipped rather than costing a
   * Describe call per service. Unavailable on any account without an aggregator
   * index - which a read-only role cannot create - so this always degrades to
   * scanning every candidate region.
   */
  const fastPath = await discoverActiveRegions(ctx);
  const { regions, skipped } = narrowRegions(candidateRegions, fastPath, cfg.AWS_REGION);
  if (fastPath.available && skipped.length > 0) {
    console.log(
      `  resource-explorer: ${fastPath.resourceCount} resources indexed; ` +
        `skipping ${skipped.length} region(s) with none (${skipped.join(", ")})`,
    );
  } else if (!fastPath.available) {
    console.log(`  resource-explorer: ${fastPath.unavailableReason}`);
  }

  const faults = faultInjections();

  // Build the unit list up front so the UI can render the full plan
  // immediately and fill it in, rather than growing a list as work completes.
  const units: ScanUnit[] = [];
  for (const service of SCANNABLE_SERVICES) {
    if (COLLECTORS[service].scope === "global") {
      units.push({
        service,
        region: null,
        status: "pending",
        resourceCount: 0,
        apiCalls: 0,
        durationMs: 0,
      });
    } else {
      for (const region of regions) {
        units.push({
          service,
          region,
          status: "pending",
          resourceCount: 0,
          apiCalls: 0,
          durationMs: 0,
        });
      }
    }
  }

  emit({
    type: "scan.started",
    scanId,
    regions,
    units: structuredClone(units),
    accountId: session.accountId,
  });

  let completed = 0;
  const outputs: CollectorOutput[] = [];
  const unitOutputs: CollectedEstate["unitOutputs"] = [];

  const tasks = units.map((unit) => async () => {
    const key = `${unit.service}:${unit.region ?? "global"}`;
    const startedAt = new Date();
    unit.status = "running";
    unit.startedAt = startedAt.toISOString();
    emit({ type: "unit.started", scanId, service: unit.service, region: unit.region });

    const callsBefore = counter.get(`${unit.service}:${unit.region ?? "global"}`);

    try {
      // Testing hook. Lets the partial-failure UI be demonstrated on a mock
      // that is otherwise too well behaved to fail. Never set in production.
      if (faults.has(key) || faults.has(`${unit.service}:*`)) {
        const injected = new Error(`Injected fault for ${key}`);
        injected.name = "ThrottlingException";
        throw injected;
      }

      const output = await COLLECTORS[unit.service].collect({
        ...ctx,
        unitKey: key,
        region: unit.region,
        accountId: session.accountId,
      });
      outputs.push(output);
      unitOutputs.push({ unit, output });
      unit.status = "succeeded";
      unit.resourceCount = output.resources.length;
    } catch (err) {
      unit.status = "failed";
      unit.error = explainFailure(
        unit.service,
        unit.region,
        err,
        COLLECTORS[unit.service].permissions,
      );
      unit.errorCode = errorCodeOf(err);
      console.warn(`  ${key}: ${unit.error}`);
    } finally {
      unit.durationMs = Date.now() - startedAt.getTime();
      unit.finishedAt = new Date().toISOString();
      unit.apiCalls = counter.get(`${unit.service}:${unit.region ?? "global"}`) - callsBefore;
      completed++;
      emit({ type: "unit.finished", scanId, unit: structuredClone(unit) });
      emit({ type: "scan.progress", scanId, completed, total: units.length });
    }
  });

  await runWithConcurrency(tasks, cfg.SCAN_CONCURRENCY);

  return {
    accountId: session.accountId,
    regions,
    units,
    collected: mergeOutputs(outputs),
    unitOutputs,
  };
}

export { rollUpStatus };
