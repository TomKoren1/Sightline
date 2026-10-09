/**
 * Turning a CloudFormation failure into the thing to fix.
 *
 * `aws cloudformation deploy` prints "Failed to create/update the stack. Run the
 * following command to fetch the list of events" — one more step than necessary
 * when the script can fetch them itself. These are the failures actually seen on
 * a real account, quoted from what CloudFormation returned.
 */

import { describe, expect, it } from "vitest";

import { explainStackFailure, failureReasonsSince, type FailureEvent } from "./aws.js";

/** Verbatim, from a failed deploy in a real account. */
const INVALID_PRINCIPAL =
  'Resource handler returned message: "Invalid principal in policy: "AWS":' +
  '"arn:aws:iam::672299759593:role/SightlineScanner" (Service: Iam, Status Code: 400)"';

describe("explainStackFailure", () => {
  it("always includes the reason CloudFormation gave", () => {
    // The explanation supplements the original; it never replaces it, because a
    // reader searching the web needs the exact wording.
    expect(explainStackFailure([INVALID_PRINCIPAL])[0]).toBe(INVALID_PRINCIPAL);
  });

  it("explains an invalid principal, which is the placeholder mistake", () => {
    const out = explainStackFailure([INVALID_PRINCIPAL]).join("\n");
    expect(out).toMatch(/does not exist in this account/);
    // And says how to get the right value.
    expect(out).toContain("get-caller-identity");
  });

  it("explains a name collision as a role the stack does not own", () => {
    const out = explainStackFailure([
      "Resource of type 'AWS::IAM::Role' with identifier 'SightlineReadOnlyRole' already exists.",
    ]).join("\n");
    expect(out).toMatch(/already there but not owned/);
  });

  it("explains a permissions failure as a missing IAM grant", () => {
    const out = explainStackFailure([
      "User: arn:aws:iam::1:user/x is not authorized to perform: iam:CreateRole",
    ]).join("\n");
    expect(out).toMatch(/lacks IAM permissions/);
    expect(out).toContain("IAMFullAccess");
  });

  it("passes an unrecognised reason through unchanged rather than guessing", () => {
    // Inventing an explanation for an error nobody has seen is worse than none.
    const odd = "Something nobody has hit before happened";
    expect(explainStackFailure([odd])).toEqual([odd]);
  });

  it("returns nothing for no reasons, so the caller can fall back", () => {
    expect(explainStackFailure([])).toEqual([]);
  });
});

describe("failureReasonsSince", () => {
  /**
   * A stack keeps its failed events for ever, so an unbounded query attributes
   * every future failure to the oldest one it finds.
   *
   * Observed doing exactly that: a deploy that failed before CloudFormation was
   * reached — the template file was missing — was reported as
   * `Invalid principal in policy`, an unrelated failure from twelve hours earlier,
   * with the real error suppressed behind it. Both timestamps below are the real
   * ones from that incident.
   */
  const OLD: FailureEvent = [
    "2026-09-29T01:28:24.811000+00:00",
    'Invalid principal in policy: "AWS":"arn:aws:iam::672299759593:role/SightlineScanner"',
  ];
  const attemptStarted = new Date("2026-09-29T13:00:00.000Z");

  it("excludes a failure from a previous attempt", () => {
    expect(failureReasonsSince([OLD], attemptStarted)).toEqual([]);
  });

  it("includes a failure from this attempt", () => {
    const fresh: FailureEvent = ["2026-09-29T13:00:04.000Z", "Something actually went wrong"];
    expect(failureReasonsSince([OLD, fresh], attemptStarted)).toEqual([
      "Something actually went wrong",
    ]);
  });

  it("allows a small grace period for clock skew", () => {
    /**
     * The CLI's clock and CloudFormation's need not agree to the millisecond, and
     * dropping the event from the attempt that has just failed is the one mistake
     * this must not make.
     */
    const justBefore: FailureEvent = ["2026-09-29T12:59:58.000Z", "Barely before the start"];
    expect(failureReasonsSince([justBefore], attemptStarted)).toEqual(["Barely before the start"]);
    // But the grace period is small, not unbounded.
    const wellBefore: FailureEvent = ["2026-09-29T12:50:00.000Z", "Ten minutes earlier"];
    expect(failureReasonsSince([wellBefore], attemptStarted)).toEqual([]);
  });

  it("deduplicates, because a rollback repeats a reason per resource", () => {
    const at = "2026-09-29T13:00:01.000Z";
    expect(
      failureReasonsSince(
        [
          [at, "Same reason"],
          [at, "Same reason"],
        ],
        attemptStarted,
      ),
    ).toEqual(["Same reason"]);
  });

  it("drops events with no reason", () => {
    expect(failureReasonsSince([["2026-09-29T13:00:01.000Z", null]], attemptStarted)).toEqual([]);
  });

  it("drops an unparseable timestamp rather than assuming it is current", () => {
    // Unreadable is not evidence of recency, and guessing would reintroduce the
    // bug for any event this cannot date.
    expect(failureReasonsSince([["not a date", "Mystery failure"]], attemptStarted)).toEqual([]);
  });

  it("returns nothing for no events, so the caller falls back to the CLI", () => {
    expect(failureReasonsSince([], attemptStarted)).toEqual([]);
  });
});
