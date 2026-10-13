#!/usr/bin/env tsx
/**
 * Run a scan, persist it, and rebuild the graph.
 *
 *   npm run scan
 *
 * The order matters: Postgres is written first and is the system of record, so
 * if the Neo4j projection fails the scan is still durable and can be
 * re-projected without going back to AWS.
 */

import { rollUpStatus, errorMessage } from "@sightline/shared";

import { CallCounter } from "../aws/clients.js";
import { closePool, migrate } from "../db/postgres.js";
import {
  createScanRun,
  currentScanId,
  failScanRun,
  markProjected,
  saveScanResult,
} from "../db/repository.js";
import { closeDriver, projectGraph, sweepSupersededScans } from "../db/neo4j.js";
import { runScan } from "../scan/runner.js";
import { ensureLocalTenant, localScope } from "../tenancy/local.js";
import { markScanned, markVerified } from "../tenancy/connections.js";
import { resolveScanTarget } from "../tenancy/scanTarget.js";
import type { ScanId } from "../tenancy/ids.js";

const started = Date.now();
const counter = new CallCounter();
let scanId: ScanId | null = null;
let scope: ReturnType<typeof localScope> | null = null;

try {
  await migrate();
  // A clone is one tenant with two connections; this creates them if absent.
  await ensureLocalTenant();
  scope = localScope();
  const target = await resolveScanTarget(scope);
  // Captured before the flip, because afterwards the "current" scan is this one.
  const previousScanId = await currentScanId(scope);

  const result = await runScan({
    target,
    counter,
    scanId: "pending",
    onEvent: (event) => {
      if (event.type === "unit.finished") {
        const where = `${event.unit.service}/${event.unit.region ?? "global"}`;
        const outcome =
          event.unit.status === "succeeded"
            ? `${event.unit.resourceCount} resources`
            : `FAILED - ${event.unit.error}`;
        console.log(`  ${where.padEnd(26)} ${outcome}`);
      }
    },
  });

  // The run row is created once the account id is known, so a scan that never
  // got credentials does not leave an orphan row attributed to nobody.
  scanId = await createScanRun(scope, result.accountId, result.regions);

  const status = rollUpStatus(result.units);
  await saveScanResult(scope, scanId, {
    status,
    units: result.units,
    resources: result.resources,
    relationships: result.relationships,
    apiCalls: counter.total(),
  });

  const projected = await projectGraph(
    { tenantId: scope.tenantId, scanId },
    result.resources,
    result.relationships,
  );
  // The flip. Until this line the connection still reads its previous graph.
  await markProjected(scope, scanId);
  await markVerified(scope, result.accountId);
  await markScanned(scope);

  /**
   * Drop the graphs nobody reads any more.
   *
   * Without this every `npm run scan` would leave its predecessor behind and
   * the graph would grow by a whole inventory per run. The previous scan is
   * kept so a reader that resolved it moments before the flip still finds it.
   */
  await sweepSupersededScans(scope.tenantId, [scanId, ...(previousScanId ? [previousScanId] : [])]);

  const failed = result.units.filter((u) => u.status === "failed").length;
  console.log(
    `\nScan ${scanId} ${status}` +
      (failed > 0 ? ` (${failed}/${result.units.length} units failed)` : "") +
      `\n  ${result.resources.length} resources, ${result.relationships.length} relationships` +
      `\n  graph: ${projected.nodes} nodes, ${projected.edges} edges` +
      `\n  ${counter.total()} AWS API calls in ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
} catch (err) {
  const message = errorMessage(err);
  console.error(`\nScan failed: ${message}`);
  if (scanId && scope) await failScanRun(scope, scanId, message);
  process.exitCode = 1;
} finally {
  await closeDriver();
  await closePool();
}
