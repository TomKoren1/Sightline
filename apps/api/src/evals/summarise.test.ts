/**
 * A run that did not happen is not a bad score.
 *
 * Four cases erroring after an Anthropic spend cap was reached reported
 * "17/21 cases passed, mean F1 0.81" in the Trust panel. Every one of those
 * numbers is arithmetically correct and the conclusion a reader draws from them
 * - the agent got worse - is false. The four requests were refused with
 * `400 invalid_request_error: You have reached your specified API usage limits`
 * and never reached the model.
 *
 * Worse than misreporting: the run was then written to `eval_runs`, which is
 * what the Trust panel reads and what the next run is diffed against, so an
 * outage replaced the baseline it should have been compared to.
 *
 * These assertions pin the distinction between "answered badly" and "never ran".
 */

import { describe, expect, it } from "vitest";

import { DRIFT_EXPECTED_CHECK_FAILURES } from "@sightline/mock-aws";

import { CHECKS } from "./checks.js";
import { summarise, type CaseResult } from "./grade.js";
import { isTerminalApiError } from "./terminalError.js";

const base = (id: string): CaseResult => ({
  id,
  question: `q-${id}`,
  passed: true,
  precision: 1,
  recall: 1,
  f1: 1,
  missing: [],
  falsePositives: [],
  unsupportedCitations: [],
  toolsCalled: ["find_public_resources"],
  failures: [],
  answer: "an answer",
  durationMs: 5000,
});

/** A case that never reached the model, shaped exactly as the runner records it. */
const errored = (id: string): CaseResult => ({
  ...base(id),
  passed: false,
  precision: 0,
  recall: 0,
  f1: 0,
  toolsCalled: [],
  failures: ["threw: 400 invalid_request_error: You have reached your specified API usage limits."],
  answer: "",
  durationMs: 400,
  errored: "400 invalid_request_error: You have reached your specified API usage limits.",
});

/** A genuinely wrong answer: it ran, it was graded, it lost points. */
const wrong = (id: string, f1: number): CaseResult => ({
  ...base(id),
  passed: false,
  f1,
  precision: f1,
  recall: f1,
  failures: ["did not cite: northwind-public-assets"],
});

describe("summarise separates an outage from a regression", () => {
  it("reproduces the misreport it exists to prevent", () => {
    // The run as it happened: 17 passed, then the cap was hit.
    const results = [
      ...Array.from({ length: 17 }, (_, i) => base(`ok-${i}`)),
      ...Array.from({ length: 4 }, (_, i) => errored(`capped-${i}`)),
    ];
    const s = summarise(results);

    expect(s.total).toBe(21);
    expect(s.errored).toBe(4);
    expect(s.graded).toBe(17);

    // What the old code reported, and why it was wrong.
    const oldMeanF1 = results.reduce((a, r) => a + r.f1, 0) / results.length;
    expect(Math.round(oldMeanF1 * 100) / 100).toBe(0.81);

    // Seventeen ran and seventeen passed. Nothing about answer quality moved.
    expect(s.passed).toBe(17);
    expect(s.failed).toBe(0);
    expect(s.meanF1).toBe(1);
  });

  it("still reports a real regression at full strength", () => {
    // No errors, one genuinely wrong answer. The mean must drop.
    const s = summarise([base("a"), base("b"), wrong("c", 0.5)]);
    expect(s.errored).toBe(0);
    expect(s.graded).toBe(3);
    expect(s.failed).toBe(1);
    expect(s.meanF1).toBeCloseTo(0.833, 3);
  });

  it("does not let an outage mask a regression in the cases that did run", () => {
    // The dangerous inverse of the first case: if errored cases were simply
    // dropped from both numerator and denominator without being counted, a run
    // that half-executed and half-regressed would look partially fine.
    const s = summarise([base("a"), wrong("b", 0), errored("c")]);
    expect(s.graded).toBe(2);
    expect(s.passed).toBe(1);
    expect(s.failed).toBe(1);
    expect(s.errored).toBe(1);
    expect(s.meanF1).toBe(0.5);
  });

  it("reports zero rather than NaN when nothing ran at all", () => {
    const s = summarise([errored("a"), errored("b")]);
    expect(s.graded).toBe(0);
    expect(s.passed).toBe(0);
    expect(s.failed).toBe(0);
    expect(s.errored).toBe(2);
    expect(s.meanF1).toBe(0);
    expect(Number.isNaN(s.meanF1)).toBe(false);
  });

  it("counts unsupported citations from every case, errored included", () => {
    // An errored case has none, but the count must not silently exclude a
    // category of case - that is how a fatal signal gets lost.
    const withBadCitation: CaseResult = { ...base("d"), unsupportedCitations: ["arn:aws:fake"] };
    const s = summarise([withBadCitation, errored("e")]);
    expect(s.unsupportedCitations).toBe(1);
  });
});

describe("isTerminalApiError", () => {
  it("recognises the refusal that actually stopped a run", () => {
    // Verbatim, from request req_011CfTednQXFuKZof1CUFeVf.
    expect(
      isTerminalApiError(
        '400 {"type":"error","error":{"type":"invalid_request_error","message":"You have reached ' +
          'your specified API usage limits. You will regain access on 2026-10-01 at 00:00 UTC."}}',
      ),
    ).toBe(true);
  });

  it.each([
    ["low credit", "Your credit balance is too low to access the Anthropic API"],
    ["rate limit", "429 rate_limit_error: Number of request tokens has exceeded your per-minute"],
    ["bad key", "401 authentication_error: invalid x-api-key"],
    ["no permission", "403 permission_error: Your API key does not have permission"],
  ])("stops the run on %s", (_label, message) => {
    expect(isTerminalApiError(message)).toBe(true);
  });

  it.each([
    ["a malformed request", "400 invalid_request_error: messages.0.content: expected array"],
    ["a model typo", "404 not_found_error: model: claude-sonnet-6"],
    ["a transient overload", "529 overloaded_error: Overloaded"],
    [
      "a tool schema problem",
      "400 invalid_request_error: tools.3.input_schema: invalid JSON schema",
    ],
  ])("keeps going on %s", (_label, message) => {
    // These are either per-case or worth retrying, so aborting the whole run
    // would hide information rather than save it. An overload in particular is
    // the one case where the next question may well succeed.
    expect(isTerminalApiError(message)).toBe(false);
  });
});

/**
 * The drift attribution map has to name checks that exist.
 *
 * Cheap counterpart to the integration assertion in `groundTruth.test.ts`: this
 * one needs no stack, so a renamed check id is caught on every unit run rather
 * than only where moto is available. A stale id silently stops attributing, and
 * a correct detection goes back to rendering as a defect.
 */
describe("drift attribution map", () => {
  it("names only checks that exist", () => {
    const ids = new Set(CHECKS.map((c) => c.id));
    for (const id of Object.keys(DRIFT_EXPECTED_CHECK_FAILURES)) {
      expect(ids, `DRIFT_EXPECTED_CHECK_FAILURES names "${id}", which is not a check`).toContain(
        id,
      );
    }
  });

  it("is not empty, and every entry explains itself", () => {
    const entries = Object.entries(DRIFT_EXPECTED_CHECK_FAILURES);
    expect(
      entries.length,
      "drift changes the account, so something must be expected to fail",
    ).toBeGreaterThan(0);
    for (const [id, why] of entries) {
      // The reason is rendered to the user in the panel, so it has to read as
      // an explanation rather than a label.
      expect(why.length, `the reason for ${id} is too short to explain anything`).toBeGreaterThan(
        40,
      );
      expect(why, `the reason for ${id} should name a resource`).toMatch(/[a-z]+-[a-z0-9-]+/);
    }
  });
});
