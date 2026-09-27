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
  GLOBAL_SERVICES,
  SCANNABLE_SERVICES,
  rollUpStatus,
  type ScanEvent,
  type ScannableService,
  type ScanResult,
  type ScanUnit,
} from "@daveio/shared";

import { cfg, faultInjections } from "../config.js";
import { callCounter } from "../aws/clients.js";
import { getSession } from "../aws/credentials.js";
import { resolveRegions } from "../aws/regions.js";
import { discoverActiveRegions, narrowRegions } from "../aws/resourceExplorer.js";
import { runWithConcurrency } from "./limiter.js";
import { mergeOutputs, type Collector, type CollectorOutput } from "./collectors/types.js";
import { collectEc2 } from "./collectors/ec2.js";
import { collectVpc } from "./collectors/vpc.js";
import { collectS3 } from "./collectors/s3.js";
import { collectIam } from "./collectors/iam.js";
import { collectRds } from "./collectors/rds.js";
import { collectLambda } from "./collectors/lambda.js";
import { annotate } from "./pipeline.js";
import type { TenantId } from "../tenancy/tenant.js";

const COLLECTORS: Record<ScannableService, Collector> = {
  ec2: collectEc2,
  vpc: collectVpc,
  s3: collectS3,
  iam: collectIam,
  rds: collectRds,
  lambda: collectLambda,
};

export interface ScanOptions {
  /** Whose AWS account to scan. Every client built below is bound to it. */
  tenantId: TenantId;
  /** Called as units start and finish, so the UI can show live progress. */
  onEvent?: (event: ScanEvent) => void;
  scanId: string;
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
function explainFailure(service: string, region: string | null, err: unknown): string {
  const code = errorCodeOf(err);
  const where = region ? `${service} in ${region}` : service;
  const message = err instanceof Error ? err.message : String(err);

  switch (code) {
    case "UnauthorizedOperation":
    case "AccessDenied":
    case "AccessDeniedException":
      return `Not permitted to read ${where}. The role is missing a Describe/List permission for this service.`;
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

export async function runScan(options: ScanOptions): Promise<ScanResult & { units: ScanUnit[] }> {
  const { tenantId, scanId, onEvent } = options;
  const emit = (event: ScanEvent) => onEvent?.(event);

  // Without credentials there is no scan to report on - this is the one
  // genuinely fatal failure.
  const session = await getSession(tenantId);
  const { regions: candidateRegions } = await resolveRegions(tenantId, session.endpoint);

  /**
   * Optional fast path. One Resource Explorer query can tell us which regions
   * actually hold resources, so the rest are skipped rather than costing a
   * Describe call per service. Unavailable on any account without an aggregator
   * index - which a read-only role cannot create - so this always degrades to
   * scanning every candidate region.
   */
  const fastPath = await discoverActiveRegions(tenantId, session.endpoint);
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
    if (GLOBAL_SERVICES.has(service)) {
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

  emit({ type: "scan.started", scanId, regions, units: structuredClone(units) });

  let completed = 0;
  const outputs: CollectorOutput[] = [];

  const tasks = units.map((unit) => async () => {
    const key = `${unit.service}:${unit.region ?? "global"}`;
    const startedAt = new Date();
    unit.status = "running";
    unit.startedAt = startedAt.toISOString();
    emit({ type: "unit.started", scanId, service: unit.service, region: unit.region });

    const callsBefore = callCounter.get(`${unit.service}:${unit.region ?? "global"}`);

    try {
      // Testing hook. Lets the partial-failure UI be demonstrated on a mock
      // that is otherwise too well behaved to fail. Never set in production.
      if (faults.has(key) || faults.has(`${unit.service}:*`)) {
        const injected = new Error(`Injected fault for ${key}`);
        injected.name = "ThrottlingException";
        throw injected;
      }

      const output = await COLLECTORS[unit.service]({
        region: unit.region,
        accountId: session.accountId,
        tenantId,
        endpoint: session.endpoint,
      });
      outputs.push(output);
      unit.status = "succeeded";
      unit.resourceCount = output.resources.length;
    } catch (err) {
      unit.status = "failed";
      unit.error = explainFailure(unit.service, unit.region, err);
      unit.errorCode = errorCodeOf(err);
      console.warn(`  ${key}: ${unit.error}`);
    } finally {
      unit.durationMs = Date.now() - startedAt.getTime();
      unit.finishedAt = new Date().toISOString();
      unit.apiCalls = callCounter.get(`${unit.service}:${unit.region ?? "global"}`) - callsBefore;
      completed++;
      emit({ type: "unit.finished", scanId, unit: structuredClone(unit) });
      emit({ type: "scan.progress", scanId, completed, total: units.length });
    }
  });

  await runWithConcurrency(tasks, cfg.SCAN_CONCURRENCY);

  const merged = mergeOutputs(outputs);
  const annotated = annotate(session.accountId, regions, merged);

  return { ...annotated, units };
}

export { rollUpStatus };
