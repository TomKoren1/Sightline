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

import { cfg, isMock } from "../config.js";
import { ask } from "../agent/agent.js";
import { EVAL_CASES } from "../evals/cases.js";
import { gradeCase, summarise, type CaseResult } from "../evals/grade.js";
import { listResources } from "../db/queries.js";
import { closeDriver } from "../db/neo4j.js";
import { closePool, pool } from "../db/postgres.js";
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
      });
    }
  }

  const summary = summarise(results);
  console.log(
    `\n${bold("Result")} ${summary.passed}/${summary.total} passed · mean F1 ${summary.meanF1}` +
      (summary.unsupportedCitations > 0
        ? red(` · ${summary.unsupportedCitations} unsupported citations`)
        : green(" · no unsupported citations")),
  );

  const runId = randomUUID();
  await pool.query(
    `INSERT INTO eval_runs (id, model, total, passed, mean_f1, results) VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      runId,
      cfg.ANTHROPIC_MODEL,
      summary.total,
      summary.passed,
      summary.meanF1,
      JSON.stringify(results),
    ],
  );

  // Also written to disk, so a CI run can publish it as an artifact and a
  // regression can be diffed against a previous run.
  const dir = new URL("../../../../evals/results/", import.meta.url).pathname;
  await mkdir(dir, { recursive: true });
  await writeFile(
    `${dir}${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    JSON.stringify({ runId, model: cfg.ANTHROPIC_MODEL, summary, results }, null, 2),
  );
  console.log(dim(`Written to evals/results/ and eval_runs (${runId.slice(0, 8)})`));

  if (summary.failed > 0) process.exitCode = 1;
} finally {
  await closeDriver();
  await closePool();
}
