/**
 * Evaluation endpoints, backing the Trust panel.
 *
 * "How do you know the agent is right?" is a fair question from someone about
 * to act on an answer, and answering it inside the product is more use than
 * answering it in a README. Two tiers, matching ADR-008:
 *
 *   - ground-truth checks, run on demand: free, instant, no API key, and they
 *     validate the data the user is currently looking at.
 *   - the last recorded agent eval run, read from Postgres: costs money to
 *     produce, so it is displayed rather than re-run from a web request.
 */

import type { FastifyInstance } from "fastify";

import { cfg, isMock } from "../config.js";
import { pool } from "../db/postgres.js";
import { getLatestScan, loadRelationships, loadResources } from "../db/repository.js";
import { DRIFT_MARKER_RESOURCES } from "@daveio/mock-aws";

import { CHECKS, runChecks } from "../evals/checks.js";
import { tenantOf } from "../tenancy/request.js";

export function registerEvalRoutes(app: FastifyInstance): void {
  /** What the checks cover, without running them. */
  app.get("/api/evals/checks", async () => ({
    checks: CHECKS.map((c) => ({ id: c.id, description: c.description, rationale: c.rationale })),
  }));

  /**
   * Run the ground-truth checks against the latest persisted scan.
   *
   * Reads from Postgres rather than rescanning: it is the data the UI is
   * showing that we want to validate, and it makes the call free and instant.
   */
  app.post("/api/evals/ground-truth", async (req, reply) => {
    const tenantId = tenantOf(req);
    const latest = await getLatestScan(tenantId);
    if (!latest) {
      return reply.code(409).send({
        error: "No scan has completed yet, so there is nothing to check.",
        code: "NO_SCAN",
      });
    }

    // The expected answers describe the seeded mock account. Against a real
    // customer they are meaningless, and pretending otherwise would be worse
    // than not offering the check at all.
    if (!isMock()) {
      return reply.code(409).send({
        error:
          "Ground-truth checks are defined against the seeded mock account and do not apply to a real AWS account.",
        code: "NOT_APPLICABLE",
      });
    }

    const started = Date.now();
    const [resources, relationships] = await Promise.all([
      loadResources(tenantId, latest.id),
      loadRelationships(tenantId, latest.id),
    ]);
    const results = runChecks({ resources, relationships });

    /**
     * Has the account been changed since it was seeded?
     *
     * The checks assert properties of the pristine fixture. `npm run drift`
     * deliberately breaks some of them — a bucket really does become public —
     * so a failure after drift is the checks working, not the analysers
     * breaking. Saying which situation we are in is the difference between
     * useful evidence and a red panel nobody trusts.
     */
    const drifted = resources.some((r) =>
      (DRIFT_MARKER_RESOURCES as readonly string[]).includes(r.name),
    );

    return reply.send({
      scanId: latest.id,
      scannedAt: latest.startedAt,
      durationMs: Date.now() - started,
      total: results.length,
      passed: results.filter((r) => r.passed).length,
      drifted,
      driftNote: drifted
        ? "This account has been changed since it was seeded (npm run drift). These checks describe the pristine fixture, so some are expected to fail - that is them detecting the drift. Re-seed and rescan for a clean baseline."
        : undefined,
      results,
    });
  });

  /** The most recent agent eval run, if one has been recorded. */
  app.get("/api/evals/latest", async () => {
    const { rows } = await pool.query(
      `SELECT id, started_at, model, total, passed, mean_f1, results
         FROM eval_runs ORDER BY started_at DESC LIMIT 1`,
    );
    const row = rows[0];
    if (!row) {
      return {
        run: null,
        hint: "No agent evals recorded yet. Run `npm run evals -w @daveio/api` with an API key set.",
      };
    }

    type StoredCase = {
      id: string;
      question: string;
      passed: boolean;
      f1: number;
      toolsCalled: string[];
      failures: string[];
      unsupportedCitations: string[];
      durationMs: number;
    };

    const cases = (row.results as StoredCase[]).map((c) => ({
      id: c.id,
      question: c.question,
      passed: c.passed,
      f1: c.f1,
      toolsCalled: c.toolsCalled,
      failures: c.failures,
      unsupportedCitations: c.unsupportedCitations?.length ?? 0,
      durationMs: c.durationMs,
    }));

    return {
      run: {
        id: row.id,
        startedAt: row.started_at.toISOString(),
        model: row.model,
        total: row.total,
        passed: row.passed,
        meanF1: row.mean_f1,
        unsupportedCitations: cases.reduce((s, c) => s + c.unsupportedCitations, 0),
        cases,
      },
      // The agent is only as trustworthy as the model behind it, so which one
      // produced these numbers matters as much as the numbers.
      currentModel: cfg.ANTHROPIC_MODEL,
    };
  });
}
