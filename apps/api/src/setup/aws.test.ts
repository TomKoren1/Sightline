/**
 * Turning a CloudFormation failure into the thing to fix.
 *
 * `aws cloudformation deploy` prints "Failed to create/update the stack. Run the
 * following command to fetch the list of events" — one more step than necessary
 * when the script can fetch them itself. These are the failures actually seen on
 * a real account, quoted from what CloudFormation returned.
 */

import { describe, expect, it } from "vitest";

import { explainStackFailure } from "./aws.js";

/** Verbatim, from a failed deploy in a real account. */
const INVALID_PRINCIPAL =
  'Resource handler returned message: "Invalid principal in policy: "AWS":' +
  '"arn:aws:iam::672299759593:role/DaveIoScanner" (Service: Iam, Status Code: 400)"';

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
      "Resource of type 'AWS::IAM::Role' with identifier 'DaveIoReadOnlyRole' already exists.",
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
