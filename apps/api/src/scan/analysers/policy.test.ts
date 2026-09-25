import { describe, expect, it } from "vitest";
import { documentGrantsAdmin, evaluateAdmin } from "./policy.js";

const adminDoc = {
  Version: "2012-10-17",
  Statement: [{ Effect: "Allow", Action: "*", Resource: "*" }],
};

describe("documentGrantsAdmin", () => {
  it("detects the canonical AdministratorAccess shape", () => {
    expect(documentGrantsAdmin(adminDoc).yes).toBe(true);
  });

  it("detects admin granted through arrays rather than bare strings", () => {
    expect(
      documentGrantsAdmin({ Statement: [{ Effect: "Allow", Action: ["*"], Resource: ["*"] }] }).yes,
    ).toBe(true);
  });

  it("returns the statement id, so the reason can name the evidence", () => {
    const result = documentGrantsAdmin({
      Statement: [{ Sid: "CatchAll", Effect: "Allow", Action: "*", Resource: "*" }],
    });
    expect(result).toEqual({ yes: true, sid: "CatchAll" });
  });

  it("does not treat a broad Deny as admin", () => {
    expect(
      documentGrantsAdmin({ Statement: [{ Effect: "Deny", Action: "*", Resource: "*" }] }).yes,
    ).toBe(false);
  });

  it("does not treat service-wide access as account-wide admin", () => {
    expect(
      documentGrantsAdmin({ Statement: [{ Effect: "Allow", Action: "s3:*", Resource: "*" }] }).yes,
    ).toBe(false);
  });

  it("does not treat wildcard actions on a scoped resource as admin", () => {
    expect(
      documentGrantsAdmin({
        Statement: [{ Effect: "Allow", Action: "*", Resource: "arn:aws:s3:::my-bucket/*" }],
      }).yes,
    ).toBe(false);
  });

  it("ignores conditioned grants, which are restricted in ways we do not evaluate", () => {
    expect(
      documentGrantsAdmin({
        Statement: [
          {
            Effect: "Allow",
            Action: "*",
            Resource: "*",
            Condition: { Bool: { "aws:MultiFactorAuthPresent": "true" } },
          },
        ],
      }).yes,
    ).toBe(false);
  });

  it("ignores NotAction, which inverts the match and is out of scope", () => {
    expect(
      documentGrantsAdmin({ Statement: [{ Effect: "Allow", NotAction: "iam:*", Resource: "*" }] })
        .yes,
    ).toBe(false);
  });

  it("handles a missing or unparseable document", () => {
    expect(documentGrantsAdmin(null).yes).toBe(false);
    expect(documentGrantsAdmin({}).yes).toBe(false);
  });
});

describe("evaluateAdmin", () => {
  it("names the managed policy that granted admin", () => {
    const verdict = evaluateAdmin([
      { policyName: "AdministratorAccess", kind: "managed", document: adminDoc },
    ]);
    expect(verdict.isAdmin).toBe(true);
    expect(verdict.reason).toContain("AdministratorAccess");
    expect(verdict.via).toMatchObject({ policyName: "AdministratorAccess", kind: "managed" });
  });

  it("finds admin granted inline under an innocuous policy name", () => {
    const verdict = evaluateAdmin([
      {
        policyName: "ReadOnlyAccess",
        kind: "managed",
        document: { Statement: [{ Effect: "Allow", Action: "s3:Get*", Resource: "*" }] },
      },
      { policyName: "legacy-deploy-inline", kind: "inline", document: adminDoc },
    ]);
    expect(verdict.isAdmin).toBe(true);
    expect(verdict.via?.kind).toBe("inline");
  });

  it("reports no policies distinctly from policies that grant nothing", () => {
    expect(evaluateAdmin([]).reason).toBe("No policies attached");
    expect(
      evaluateAdmin([{ policyName: "Scoped", kind: "managed", document: { Statement: [] } }])
        .reason,
    ).toContain("None of the 1");
  });

  it("says so when a policy could not be read, rather than implying it is safe", () => {
    const verdict = evaluateAdmin([
      { policyName: "Unreadable", kind: "managed", document: null },
      { policyName: "Scoped", kind: "managed", document: { Statement: [] } },
    ]);
    expect(verdict.isAdmin).toBe(false);
    expect(verdict.reason).toContain("could not be read");
    expect(verdict.reason).toContain("Unreadable");
  });
});
