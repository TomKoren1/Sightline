/**
 * Ground-truth failures that `npm run drift` explains, told apart from ones it
 * does not. Here rather than in the HTTP service because it reads the mock
 * account's answer key, which only evals/ and cli/ may reach.
 */

import type { Resource } from "@sightline/shared";
import {
  DRIFT_EXPECTED_CHECK_FAILURES,
  DRIFT_MARKER_RESOURCES,
} from "@sightline/mock-aws/answer-key";

import type { CheckResult } from "./checks.js";

export function attributeDrift(
  resources: Resource[],
  results: CheckResult[],
): { drifted: boolean; annotated: (CheckResult & { expectedAfterDrift: string | null })[] } {
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
        ? (DRIFT_EXPECTED_CHECK_FAILURES[r.id] ?? null)
        : null,
  }));
  return { drifted, annotated };
}
