#!/usr/bin/env tsx
/**
 * Run a scan, persist it, and rebuild the graph.
 *
 *   npm run scan
 *
 * Goes through `runScanJob`, the same function a queue worker calls, rather
 * than keeping its own copy of the sequence. It had one, and the two had
 * already drifted: this file's version would project and flip a scan that read
 * nothing, filing an empty inventory as the account's current state. Write-
 * then-flip is now written down once.
 *
 * What stays here is the part that is genuinely about being a command line: a
 * line per unit as it finishes, and a summary at the end. It queues nothing and
 * waits for no worker - there is no worker running during `npm run scan`, and
 * one command that does the work is the right shape for a command.
 */

import { randomUUID } from "node:crypto";

import { closePool, migrate } from "../db/postgres.js";
import { closeDriver } from "../db/neo4j.js";
import { runScanJob } from "../jobs/runScanJob.js";
import { ensureLocalTenant, localScope } from "../tenancy/local.js";

const started = Date.now();

try {
  await migrate();
  // A clone is one tenant with two connections; this creates them if absent.
  await ensureLocalTenant();
  const scope = localScope();

  const outcome = await runScanJob({
    scope,
    // No job row to correlate against, so a fresh id. Only ever seen in an
    // event emitted before the run row exists.
    correlationId: randomUUID(),
    onEvent: (event) => {
      if (event.type === "unit.finished") {
        const where = `${event.unit.service}/${event.unit.region ?? "global"}`;
        const result =
          event.unit.status === "succeeded"
            ? `${event.unit.resourceCount} resources`
            : `FAILED - ${event.unit.error}`;
        console.log(`  ${where.padEnd(26)} ${result}`);
      }
    },
    logError: (err) => {
      // The message is printed from the outcome below; this is the stack, which
      // is what a developer running the command actually wants.
      if (err instanceof Error && err.stack) console.error(err.stack);
    },
  });

  if (!outcome.summary) {
    console.error(`\nScan failed: ${outcome.error ?? "no reason was recorded"}`);
    process.exitCode = 1;
  } else {
    const { summary } = outcome;
    const failed = summary.units.filter((u) => u.status === "failed").length;
    console.log(
      `\nScan ${outcome.scanId} ${outcome.status}` +
        (failed > 0 ? ` (${failed}/${summary.units.length} units failed)` : "") +
        `\n  ${summary.resources} resources, ${summary.relationships} relationships` +
        `\n  graph: ${summary.graph.nodes} nodes, ${summary.graph.edges} edges` +
        `\n  ${summary.apiCalls} AWS API calls in ${((Date.now() - started) / 1000).toFixed(1)}s`,
    );
  }
} catch (err) {
  // `runScanJob` records its own failures and does not throw, so reaching here
  // means the setup before it did - no database, or no connection to scan.
  console.error(`\nScan could not start: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await closeDriver();
  await closePool();
}
