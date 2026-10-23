import { describe, expect, it } from "vitest";
import { publicGrant, resourcePolicyVerdict } from "./resourcePolicy.js";

const policy = (statement: object) =>
  JSON.stringify({ Version: "2012-10-17", Statement: [statement] });

describe("publicGrant", () => {
  it("finds an unconditional grant to everyone", () => {
    expect(
      publicGrant(
        policy({ Effect: "Allow", Principal: "*", Action: "sqs:SendMessage", Resource: "*" }),
      ),
    ).toEqual({ actions: ["sqs:SendMessage"] });
  });

  it("reads the AWS-wildcard spelling of everyone", () => {
    expect(
      publicGrant(
        policy({
          Effect: "Allow",
          Principal: { AWS: "*" },
          Action: "secretsmanager:GetSecretValue",
        }),
      ),
    ).not.toBeNull();
  });

  it("does not call SNS's default, owner-conditioned policy public", () => {
    const snsDefault = policy({
      Sid: "__default_statement_ID",
      Effect: "Allow",
      Principal: { AWS: "*" },
      Action: ["SNS:Publish", "SNS:Subscribe"],
      Condition: { StringEquals: { "AWS:SourceOwner": "123456789012" } },
    });
    expect(publicGrant(snsDefault)).toBeNull();
  });

  it("does not call a grant to one account public", () => {
    expect(
      publicGrant(
        policy({
          Effect: "Allow",
          Principal: { AWS: "arn:aws:iam::210987654321:root" },
          Action: "kms:Decrypt",
        }),
      ),
    ).toBeNull();
  });

  it("treats a condition that excludes nobody as no condition", () => {
    expect(
      publicGrant(
        policy({
          Effect: "Allow",
          Principal: "*",
          Action: "sqs:SendMessage",
          Condition: { IpAddress: { "aws:SourceIp": "0.0.0.0/0" } },
        }),
      ),
    ).not.toBeNull();
  });
});

describe("resourcePolicyVerdict", () => {
  it("names what everyone may do", () => {
    const verdict = resourcePolicyVerdict(
      "Secret",
      policy({ Effect: "Allow", Principal: "*", Action: "secretsmanager:GetSecretValue" }),
    );
    expect(verdict.isPublic).toBe(true);
    expect(verdict.reason).toContain("secretsmanager:GetSecretValue");
  });

  it("says why a resource without a policy is private", () => {
    expect(resourcePolicyVerdict("SqsQueue", null)).toMatchObject({ isPublic: false });
  });
});
