/**
 * Grading for the agent eval suite.
 *
 * Scored on the ARNs an answer cites, not on text similarity. Citations are
 * already validated against what the tools returned, so they are a far more
 * honest signal than string-matching an expected answer - and they are
 * scoreable, which is what makes "did this change make it worse?" answerable.
 */

import type { AgentMessage } from "@sightline/shared";
import type { EvalCase } from "./cases.js";

export interface CaseResult {
  id: string;
  question: string;
  passed: boolean;
  precision: number;
  recall: number;
  f1: number;
  /** Expected but never cited. */
  missing: string[];
  /** Cited but explicitly forbidden - the traps. */
  falsePositives: string[];
  /** Cited ARNs that no tool returned. Any of these is an automatic failure. */
  unsupportedCitations: string[];
  toolsCalled: string[];
  failures: string[];
  answer: string;
  durationMs: number;
  /**
   * Set when the case never reached the model — a rate limit, a spend cap, a
   * dropped connection.
   *
   * Distinct from `passed: false` on purpose. A wrong answer is a measurement;
   * a request that was refused is the absence of one, and scoring it zero
   * reports a billing event as an answer-quality regression. That happened:
   * four cases erroring after a spend cap was reached rendered as "17/21, mean
   * F1 0.81" in the Trust panel, which reads as the agent getting worse.
   */
  errored?: string;
}

export interface NameResolver {
  /** Resolve a resource name to its ARN, or null if it does not exist. */
  (name: string): string | null;
}

export function gradeCase(
  testCase: EvalCase,
  message: AgentMessage,
  resolve: NameResolver,
  durationMs: number,
): CaseResult {
  const failures: string[] = [];
  const citedArns = new Set((message.citations ?? []).filter((c) => c.valid).map((c) => c.arn));
  const citedNames = new Set(
    (message.citations ?? [])
      .filter((c) => c.valid)
      .map((c) => c.name)
      .filter(Boolean),
  );
  const toolsCalled = (message.toolCalls ?? []).map((t) => t.name);

  /** A resource counts as cited by ARN or by name; both highlight in the UI. */
  const isCited = (name: string) => {
    if (citedNames.has(name)) return true;
    const arn = resolve(name);
    return arn ? citedArns.has(arn) : false;
  };

  const expected = testCase.expectResources ?? [];
  const missing = expected.filter((name) => !isCited(name));
  const forbidden = testCase.forbidResources ?? [];
  const falsePositives = forbidden.filter((name) => isCited(name));

  // Citation validation already flagged these; here they are fatal, because an
  // invented identifier is the one failure a user cannot catch themselves.
  const unsupportedCitations = (message.citations ?? []).filter((c) => !c.valid).map((c) => c.arn);

  if (missing.length > 0) failures.push(`did not cite: ${missing.join(", ")}`);
  if (falsePositives.length > 0) {
    failures.push(`cited resources it should not have: ${falsePositives.join(", ")}`);
  }
  if (unsupportedCitations.length > 0) {
    failures.push(`cited unsupported ARNs: ${unsupportedCitations.join(", ")}`);
  }

  if (testCase.expectTools && testCase.expectTools.length > 0) {
    if (!testCase.expectTools.some((tool) => toolsCalled.includes(tool))) {
      failures.push(
        `called none of the expected tools (${testCase.expectTools.join(", ")}); called ${
          toolsCalled.join(", ") || "nothing"
        }`,
      );
    }
  }

  for (const pattern of testCase.mustMention ?? []) {
    if (!pattern.test(message.content)) failures.push(`answer did not match ${pattern}`);
  }
  for (const pattern of testCase.mustNotMention ?? []) {
    if (pattern.test(message.content)) failures.push(`answer matched forbidden ${pattern}`);
  }

  // Precision counts the traps: an answer that names everything scores badly.
  const truePositives = expected.length - missing.length;
  const recall = expected.length === 0 ? 1 : truePositives / expected.length;
  const retrieved = truePositives + falsePositives.length;
  const precision = retrieved === 0 ? (expected.length === 0 ? 1 : 0) : truePositives / retrieved;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  return {
    id: testCase.id,
    question: testCase.question,
    passed: failures.length === 0,
    precision,
    recall,
    f1,
    missing,
    falsePositives,
    unsupportedCitations,
    toolsCalled,
    failures,
    answer: message.content,
    durationMs,
  };
}

/**
 * Roll up a run.
 *
 * `meanF1` is averaged over **graded** cases only. Including a case that never
 * reached the model drags the mean towards zero in proportion to how much of
 * the run failed to execute, which is a number about the API's availability
 * wearing the costume of a number about answer quality.
 */
export function summarise(results: CaseResult[]) {
  const graded = results.filter((r) => !r.errored);
  const errored = results.length - graded.length;
  const passed = graded.filter((r) => r.passed).length;
  const meanF1 = graded.length === 0 ? 0 : graded.reduce((s, r) => s + r.f1, 0) / graded.length;
  return {
    total: results.length,
    /** How many actually ran. `passed` and `meanF1` are out of this, not `total`. */
    graded: graded.length,
    passed,
    failed: graded.length - passed,
    errored,
    meanF1: Math.round(meanF1 * 1000) / 1000,
    unsupportedCitations: results.reduce((s, r) => s + r.unsupportedCitations.length, 0),
  };
}
