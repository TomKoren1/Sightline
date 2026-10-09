#!/usr/bin/env tsx
/**
 * Agent eval suite.
 *
 *   npm run evals -w @daveio/api
 *
 * Runs every case against the live agent, scores the answers, writes the run
 * to Postgres and prints a report. Exits non-zero if anything failed, so it
 * can gate a change in CI.
 *
 * Needs an Anthropic key and a populated graph. Tier one of the eval suite
 * (`src/evals/groundTruth.test.ts`) needs neither and covers the data itself.
 */

import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { cfg, isMock } from "../config.js";
import { ask } from "../agent/agent.js";
import { EVAL_CASES } from "../evals/cases.js";
import { gradeCase, summarise, type CaseResult } from "../evals/grade.js";
import { isTerminalApiError } from "../evals/terminalError.js";
import { listResources } from "../db/queries.js";
import { closeDriver } from "../db/neo4j.js";
import { closePool, db } from "../db/postgres.js";
import { evalRuns } from "../db/schema.js";
import { getLatestScan } from "../db/repository.js";

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;

const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const cases = only.length > 0 ? EVAL_CASES.filter((c) => only.includes(c.id)) : EVAL_CASES;

try {
  if (!cfg.ANTHROPIC_API_KEY || cfg.ANTHROPIC_API_KEY === "replace-me") {
    console.error("ANTHROPIC_API_KEY is not set. Add it to .env and try again.");
    console.error("The ground-truth suite runs without a key: npx vitest run src/evals");
    process.exit(1);
  }

  /**
   * Refuse to run against a real account.
   *
   * Every case asserts against the seeded fixture - `northwind-prod-db`,
   * `prod-bastion` and the rest. Against a real estate they would all fail for
   * the same uninteresting reason, after spending money on sixteen model calls
   * to get there. Same hazard as the ground-truth suite (engineering log #23),
   * which is why it is checked the same way.
   */
  if (!isMock()) {
    console.error(
      "AWS_MODE is not 'mock'. These cases assert against the seeded fixture, so they\n" +
        "would fail against a real account after spending money to do it.\n\n" +
        "Either set AWS_MODE=mock in .env, or use the Demo toggle in the UI and re-scan.",
    );
    process.exit(1);
  }

  const latest = await getLatestScan();
  if (!latest) {
    console.error("No scan found. Run `npm run scan` first.");
    process.exit(1);
  }

  // Names are resolved once, so grading does not hit the database per case.
  const all = await listResources({ limit: 500 });
  const arnByName = new Map(all.map((r) => [r.name, r.arn]));
  const resolve = (name: string) => arnByName.get(name) ?? null;

  console.log(
    `${bold("Agent evals")} ${dim(`${cases.length} cases · ${cfg.ANTHROPIC_MODEL} · scan ${latest.id.slice(0, 8)}`)}\n`,
  );

  const results: CaseResult[] = [];
  /** Set to the error message when the run stopped early; suppresses the insert. */
  let aborted: string | null = null;

  // Sequential on purpose: parallel runs hit rate limits and make timings
  // meaningless, and a suite this size does not need the speed.
  for (const testCase of cases) {
    process.stdout.write(`  ${testCase.id.padEnd(26)}`);
    const started = Date.now();
    try {
      const message = await ask({ question: testCase.question });
      const result = gradeCase(testCase, message, resolve, Date.now() - started);
      results.push(result);
      console.log(
        `${result.passed ? green("PASS") : red("FAIL")} ${dim(
          `f1=${result.f1.toFixed(2)} ${result.toolsCalled.length} tools ${(result.durationMs / 1000).toFixed(1)}s`,
        )}`,
      );
      for (const failure of result.failures) console.log(`      ${red("·")} ${failure}`);
      if (!result.passed) console.log(dim(`      why it matters: ${testCase.rationale}`));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(red(`ERROR ${message}`));
      results.push({
        id: testCase.id,
        question: testCase.question,
        passed: false,
        precision: 0,
        recall: 0,
        f1: 0,
        missing: [],
        falsePositives: [],
        unsupportedCitations: [],
        toolsCalled: [],
        failures: [`threw: ${message}`],
        answer: "",
        durationMs: Date.now() - started,
        // Marks this as "never ran" rather than "answered badly", which is what
        // keeps it out of meanF1 and out of the stored baseline.
        errored: message,
      });

      if (isTerminalApiError(message)) {
        aborted = message;
        const remaining = cases.length - results.length;
        if (remaining > 0) {
          console.log(
            red(
              `\n  Aborting: this will fail identically for the remaining ${remaining} case${
                remaining === 1 ? "" : "s"
              }.`,
            ),
          );
        }
        break;
      }
    }
  }

  const summary = summarise(results);
  const incomplete = aborted !== null || summary.errored > 0 || results.length < cases.length;

  /**
   * Attempted but refused, versus never attempted at all.
   *
   * Three different numbers, and the first draft of this message conflated the
   * last two - reporting "1 case errored and 21 of 21 never ran" for a run where
   * one case was attempted and twenty were not. A message about miscounting that
   * miscounts is worse than none.
   */
  const notAttempted = cases.length - results.length;

  // Scores are stated out of what actually ran. "17/21" when four never left
  // the machine is not a worse score, it is a different measurement.
  console.log(
    `\n${bold("Result")} ` +
      (summary.graded === 0
        ? red("nothing was graded")
        : `${summary.passed}/${summary.graded} passed · mean F1 ${summary.meanF1}`) +
      (summary.unsupportedCitations > 0
        ? red(` · ${summary.unsupportedCitations} unsupported citations`)
        : green(" · no unsupported citations")),
  );
  if (summary.errored > 0 || notAttempted > 0) {
    const parts: string[] = [];
    if (summary.errored > 0) {
      parts.push(`${summary.errored} case${summary.errored === 1 ? "" : "s"} errored`);
    }
    if (notAttempted > 0) parts.push(`${notAttempted} not attempted`);
    console.log(
      red(`       ${parts.join(", ")} of ${cases.length}. These are NOT answer-quality failures.`),
    );
    if (aborted) console.log(dim(`       ${aborted}`));
  }

  const runId = randomUUID();

  /**
   * An incomplete run is not a baseline.
   *
   * The stored run is what the Trust panel shows and what the next run is
   * diffed against, so writing a partial one replaces a real measurement with
   * an artefact of an outage - and it does so silently, because the number it
   * produces looks like a plausible score. The disk copy is still written, with
   * `-incomplete` in the name, so the evidence survives without becoming the
   * reference.
   */
  if (incomplete) {
    console.log(
      red("\n  Not recorded to eval_runs: the run did not complete, so it is not a baseline."),
    );
    console.log(dim("  The previous recorded run is left as the reference. Re-run when able."));
  } else {
    await db.insert(evalRuns).values({
      id: runId,
      model: cfg.ANTHROPIC_MODEL,
      total: summary.total,
      passed: summary.passed,
      meanF1: summary.meanF1,
      results,
    });
  }

  // Also written to disk, so a CI run can publish it as an artifact and a
  // regression can be diffed against a previous run.
  // fileURLToPath keeps the trailing separator, so the concatenation below
  // still works - and unlike URL.pathname it produces a path mkdir can use on
  // Windows and through directories containing spaces (engineering log #36).
  const dir = fileURLToPath(new URL("../../../../evals/results/", import.meta.url));
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = `${dir}${stamp}${incomplete ? "-incomplete" : ""}.json`;
  await writeFile(
    file,
    JSON.stringify(
      { runId, model: cfg.ANTHROPIC_MODEL, incomplete, aborted, summary, results },
      null,
      2,
    ),
  );
  console.log(
    dim(
      incomplete
        ? `Written to evals/results/ only (${stamp}-incomplete.json)`
        : `Written to evals/results/ and eval_runs (${runId.slice(0, 8)})`,
    ),
  );

  /**
   * Distinct exit codes, because the two outcomes need different responses: a
   * quality regression is a change to investigate, an incomplete run is a
   * measurement to repeat. Collapsing both into 1 means CI cannot tell "this
   * commit made the agent worse" from "the API was unavailable".
   */
  if (incomplete) process.exitCode = 2;
  else if (summary.failed > 0) process.exitCode = 1;
} finally {
  await closeDriver();
  await closePool();
}
