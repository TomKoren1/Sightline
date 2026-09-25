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

import { rollUpStatus } from "@daveio/shared";

import { callCounter } from "../aws/clients.js";
import { closePool, migrate } from "../db/postgres.js";
import { createScanRun, failScanRun, saveScanResult } from "../db/repository.js";
import { closeDriver, projectGraph } from "../db/neo4j.js";
import { runScan } from "../scan/runner.js";

const started = Date.now();
let scanId: string | null = null;

try {
  await migrate();

  const result = await runScan({
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
  scanId = await createScanRun(result.accountId, result.regions);

  const status = rollUpStatus(result.units);
  await saveScanResult(scanId, {
    status,
    units: result.units,
    resources: result.resources,
    relationships: result.relationships,
    apiCalls: callCounter.total(),
  });

  const projected = await projectGraph(scanId, result.resources, result.relationships);

  const failed = result.units.filter((u) => u.status === "failed").length;
  console.log(
    `\nScan ${scanId} ${status}` +
      (failed > 0 ? ` (${failed}/${result.units.length} units failed)` : "") +
      `\n  ${result.resources.length} resources, ${result.relationships.length} relationships` +
      `\n  graph: ${projected.nodes} nodes, ${projected.edges} edges` +
      `\n  ${callCounter.total()} AWS API calls in ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`\nScan failed: ${message}`);
  if (scanId) await failScanRun(scanId, message);
  process.exitCode = 1;
} finally {
  await closeDriver();
  await closePool();
}
