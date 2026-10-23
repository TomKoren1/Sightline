import { describe, expect, it } from "vitest";
import type { PolicyDocument } from "../collectors/iam.js";
import { documentGrantsAdmin, evaluateAdmin, type PolicyRef } from "./policy.js";

type Statement = NonNullable<PolicyDocument["Statement"]>[number] & { Principal?: unknown };

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

const ref = (statements: Statement[], name = "p"): PolicyRef => ({
  policyName: name,
  kind: "inline",
  document: { Statement: statements },
});

describe("evaluateAdmin: direct grants beyond the literal *:*", () => {
  it("treats NotAction that leaves IAM writable as administrator access", () => {
    const verdict = evaluateAdmin([ref([{ Effect: "Allow", NotAction: "s3:*", Resource: "*" }])]);
    expect(verdict).toMatchObject({ isAdmin: true, adminVia: "direct" });
    expect(verdict.reason).toContain("every action except s3:*");
  });

  it("does not treat a PowerUser-shaped NotAction excluding IAM as admin", () => {
    const verdict = evaluateAdmin([
      ref([
        { Effect: "Allow", NotAction: ["iam:*", "organizations:*", "account:*"], Resource: "*" },
      ]),
    ]);
    expect(verdict.isAdmin).toBe(false);
  });

  it("treats NotResource as reaching everything it does not name", () => {
    const verdict = evaluateAdmin([
      ref([{ Effect: "Allow", Action: "*", NotResource: "arn:aws:s3:::audit-logs" }]),
    ]);
    expect(verdict.isAdmin).toBe(true);
  });

  it("ignores a condition that excludes nobody", () => {
    const verdict = evaluateAdmin([
      ref([
        {
          Effect: "Allow",
          Action: "*",
          Resource: "*",
          Condition: { IpAddress: { "aws:SourceIp": ["0.0.0.0/0"] } },
        },
      ]),
    ]);
    expect(verdict.isAdmin).toBe(true);
  });

  it("lets an explicit Deny on IAM cancel a wildcard Allow", () => {
    const verdict = evaluateAdmin([
      ref([{ Effect: "Allow", Action: "*", Resource: "*" }]),
      ref([{ Effect: "Deny", Action: "iam:*", Resource: "*" }], "deny-iam"),
    ]);
    expect(verdict.isAdmin).toBe(false);
  });

  it("caps the verdict at the permissions boundary", () => {
    const boundary = ref([{ Effect: "Allow", Action: "s3:*", Resource: "*" }], "S3Only");
    const verdict = evaluateAdmin([ref([{ Effect: "Allow", Action: "*", Resource: "*" }])], {
      boundary,
    });
    expect(verdict.isAdmin).toBe(false);
    expect(verdict.reason).toContain('permissions boundary "S3Only"');
  });
});

describe("evaluateAdmin: escalation paths", () => {
  it("finds PassRole with Lambda create and invoke", () => {
    const verdict = evaluateAdmin([
      ref(
        [
          { Effect: "Allow", Action: "iam:PassRole", Resource: "*" },
          {
            Effect: "Allow",
            Action: ["lambda:CreateFunction", "lambda:InvokeFunction"],
            Resource: "*",
          },
        ],
        "DeployTooling",
      ),
    ]);
    expect(verdict).toMatchObject({
      isAdmin: true,
      adminVia: "escalation",
      escalation: { id: "passrole-lambda", policies: ["DeployTooling"] },
    });
    expect(verdict.reason).toContain("inline policy");
  });

  it("matches wildcard actions such as iam:Create*", () => {
    const verdict = evaluateAdmin([
      ref([{ Effect: "Allow", Action: "iam:Create*", Resource: "*" }]),
    ]);
    expect(verdict.escalation?.id).toBe("create-policy-version");
  });

  it("assembles a path from several policies and names them all", () => {
    const verdict = evaluateAdmin([
      ref([{ Effect: "Allow", Action: "iam:PassRole", Resource: "arn:aws:iam::*:role/*" }], "Pass"),
      ref([{ Effect: "Allow", Action: "ec2:RunInstances", Resource: "*" }], "Launch"),
    ]);
    expect(verdict.escalation).toMatchObject({ id: "passrole-ec2", policies: ["Pass", "Launch"] });
  });

  it("does not count self-service scoped to the caller's own user", () => {
    const verdict = evaluateAdmin([
      ref([
        {
          Effect: "Allow",
          Action: ["iam:CreateAccessKey", "iam:UpdateLoginProfile"],
          Resource: "arn:aws:iam::*:user/${aws:username}",
        },
      ]),
    ]);
    expect(verdict.isAdmin).toBe(false);
  });

  it("does not count half a path", () => {
    const verdict = evaluateAdmin([
      ref([{ Effect: "Allow", Action: "iam:PassRole", Resource: "*" }]),
    ]);
    expect(verdict.isAdmin).toBe(false);
  });

  it("does not count a path behind a restrictive condition", () => {
    const verdict = evaluateAdmin([
      ref([
        {
          Effect: "Allow",
          Action: "iam:CreatePolicyVersion",
          Resource: "*",
          Condition: { Bool: { "aws:MultiFactorAuthPresent": "true" } },
        },
      ]),
    ]);
    expect(verdict.isAdmin).toBe(false);
  });

  it("does not treat object access in one bucket as reaching every resource", () => {
    const verdict = evaluateAdmin([
      ref([{ Effect: "Allow", Action: "*", Resource: "arn:aws:s3:::my-bucket/*" }]),
    ]);
    expect(verdict.isAdmin).toBe(false);
  });
});
