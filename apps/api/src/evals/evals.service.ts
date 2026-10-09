/**
 * Evaluation reads, backing the Trust panel.
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

import { ConflictException, Injectable } from "@nestjs/common";
import { desc } from "drizzle-orm";

import { cfg, isMock } from "../config.js";
import { db } from "../db/postgres.js";
import { evalRuns } from "../db/schema.js";
import { getLatestScan, loadRelationships, loadResources } from "../db/repository.js";
import { DRIFT_EXPECTED_CHECK_FAILURES, DRIFT_MARKER_RESOURCES } from "@sightline/mock-aws";

import { CHECKS, runChecks } from "../evals/checks.js";

@Injectable()
export class EvalsService {
  /** What the checks cover, without running them. */
  describeChecks() {
    return {
      checks: CHECKS.map((c) => ({ id: c.id, description: c.description, rationale: c.rationale })),
    };
  }

  /**
   * Run the ground-truth checks against the latest persisted scan.
   *
   * Reads from Postgres rather than rescanning: it is the data the UI is
   * showing that we want to validate, and it makes the call free and instant.
   */
  async groundTruth() {
    const latest = await getLatestScan();
    if (!latest) {
      throw new ConflictException({
        error: "No scan has completed yet, so there is nothing to check.",
        code: "NO_SCAN",
      });
    }

    // The expected answers describe the seeded mock account. Against a real
    // customer they are meaningless, and pretending otherwise would be worse
    // than not offering the check at all.
    if (!isMock()) {
      throw new ConflictException({
        error:
          "Ground-truth checks are defined against the seeded mock account and do not apply to a real AWS account.",
        code: "NOT_APPLICABLE",
      });
    }

    const started = Date.now();
    const [resources, relationships] = await Promise.all([
      loadResources(latest.id),
      loadRelationships(latest.id),
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

    /**
     * Which failures drift explains, and which it does not.
     *
     * The note on its own was a blanket amnesty: "some of these are expected to
     * fail" excuses an analyser that genuinely broke while the account happened
     * to be drifted. Since drift is deterministic, the checks it breaks are
     * known, so each failure can be attributed or not - and an unattributed one
     * has to stay loud.
     */
    const annotated = results.map((r) => ({
      ...r,
      expectedAfterDrift:
        drifted && !r.passed && r.id in DRIFT_EXPECTED_CHECK_FAILURES
          ? DRIFT_EXPECTED_CHECK_FAILURES[r.id]
          : null,
    }));

    const failures = annotated.filter((r) => !r.passed);
    const unexplained = failures.filter((r) => r.expectedAfterDrift === null);

    return {
      scanId: latest.id,
      scannedAt: latest.startedAt,
      durationMs: Date.now() - started,
      total: results.length,
      passed: results.filter((r) => r.passed).length,
      /** Failures drift does not account for. Non-zero means investigate. */
      unexplainedFailures: unexplained.length,
      drifted,
      driftNote: !drifted
        ? undefined
        : unexplained.length === 0
          ? `This account has been changed since it was seeded (npm run drift). All ${failures.length} failing check${
              failures.length === 1 ? " is" : "s are"
            } accounted for by that change - they are detecting the drift, which is them working. Re-seed and rescan for a clean baseline.`
          : `This account has been changed since it was seeded (npm run drift), which explains ${
              failures.length - unexplained.length
            } of ${failures.length} failing checks. ${unexplained.length} ${
              unexplained.length === 1 ? "is" : "are"
            } NOT explained by the drift and should be investigated: ${unexplained
              .map((r) => r.id)
              .join(", ")}.`,
      results: annotated,
    };
  }

  /** The most recent agent eval run, if one has been recorded. */
  async latest() {
    const [row] = await db.select().from(evalRuns).orderBy(desc(evalRuns.startedAt)).limit(1);
    if (!row) {
      return {
        run: null,
        hint: "No agent evals recorded yet. Run `npm run evals -w @sightline/api` with an API key set.",
      };
    }

    interface StoredCase {
      id: string;
      question: string;
      passed: boolean;
      f1: number;
      toolsCalled: string[];
      failures: string[];
      unsupportedCitations: string[];
      durationMs: number;
      errored?: string;
    }

    /**
     * A case that never reached the model, as opposed to one that answered badly.
     *
     * Newer runs carry `errored` directly, and an incomplete run is no longer
     * recorded at all. Rows written before that fix have neither, so the
     * `threw:` prefix the runner used is read as the same signal - otherwise a
     * spend cap keeps rendering as an agent regression for as long as that row
     * remains the most recent one.
     */
    const erroredReason = (c: StoredCase): string | null =>
      c.errored ??
      c.failures?.find((f) => f.startsWith("threw: "))?.slice("threw: ".length) ??
      null;

    const cases = (row.results as StoredCase[]).map((c) => {
      const errored = erroredReason(c);
      return {
        id: c.id,
        question: c.question,
        passed: c.passed,
        f1: c.f1,
        toolsCalled: c.toolsCalled,
        failures: c.failures,
        unsupportedCitations: c.unsupportedCitations?.length ?? 0,
        durationMs: c.durationMs,
        /** Non-null when the request failed rather than the answer being wrong. */
        errored,
      };
    });

    const errored = cases.filter((c) => c.errored !== null);
    const graded = cases.length - errored.length;

    return {
      run: {
        id: row.id,
        startedAt: row.startedAt.toISOString(),
        model: row.model,
        total: row.total,
        passed: row.passed,
        /** How many cases actually ran. `passed` is out of this, not `total`. */
        graded,
        errored: errored.length,
        /**
         * Recomputed from the stored cases rather than read from `mean_f1`,
         * which for a pre-fix row averaged in a zero for every case that never
         * ran. Leaving that number in place would keep reporting an outage as a
         * quality score.
         */
        meanF1:
          graded === 0
            ? 0
            : Math.round(
                (cases.filter((c) => c.errored === null).reduce((s, c) => s + (c.f1 ?? 0), 0) /
                  graded) *
                  1000,
              ) / 1000,
        incompleteNote:
          errored.length > 0
            ? `${errored.length} of ${cases.length} cases never reached the model, so this run is not a measurement of answer quality. Re-run to get a clean baseline.`
            : undefined,
        unsupportedCitations: cases.reduce((s, c) => s + c.unsupportedCitations, 0),
        cases,
      },
      // The agent is only as trustworthy as the model behind it, so which one
      // produced these numbers matters as much as the numbers.
      currentModel: cfg.ANTHROPIC_MODEL,
    };
  }
}
