import { describe, expect, it } from "vitest";
import type { Resource } from "@sightline/shared";

import { linkCrossAccount } from "./crossAccount.js";

const OWN = "111111111111";

const role = (name: string, statement: Record<string, unknown>): Resource => ({
  arn: `arn:aws:iam::${OWN}:role/${name}`,
  kind: "IamRole",
  name,
  region: null,
  accountId: OWN,
  tags: {},
  properties: { trustPolicy: { Version: "2012-10-17", Statement: [statement] } },
  derived: {},
});

const assume = (principal: unknown, condition?: Record<string, unknown>) => ({
  Effect: "Allow",
  Principal: { AWS: principal },
  Action: "sts:AssumeRole",
  ...(condition ? { Condition: condition } : {}),
});

describe("linkCrossAccount", () => {
  it("names an unknown account that can assume a role, and notes a missing ExternalId", () => {
    const { edges, accounts } = linkCrossAccount(
      [role("Vendor", assume("arn:aws:iam::999999999999:root"))],
      OWN,
    );
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.name).toContain("not connected to Sightline");
    expect(edges[0]).toMatchObject({
      type: "CAN_ASSUME",
      properties: { externalIdRequired: false },
    });
  });

  it("names a known account by its connection, and reads ExternalId and organization conditions", () => {
    const { edges, accounts } = linkCrossAccount(
      [
        role("Deploy", assume(["222222222222"], { StringEquals: { "sts:ExternalId": "x" } })),
        role(
          "Org",
          assume("arn:aws:iam::333333333333:role/ci", {
            StringEquals: { "aws:PrincipalOrgID": "o-1" },
          }),
        ),
      ],
      OWN,
      new Map([["222222222222", "staging"]]),
    );
    expect(accounts.find((a) => a.properties["accountId"] === "222222222222")?.name).toBe(
      "staging (222222222222)",
    );
    expect(
      edges.map((e) => [e.properties?.["externalIdRequired"], e.properties?.["organizationOnly"]]),
    ).toEqual([
      [true, false],
      [false, true],
    ]);
  });

  it("ignores this account's own principals, denials, and services", () => {
    const { edges } = linkCrossAccount(
      [
        role("Self", assume(`arn:aws:iam::${OWN}:root`)),
        role("Denied", { ...assume("arn:aws:iam::999999999999:root"), Effect: "Deny" }),
        role("Ec2", {
          Effect: "Allow",
          Principal: { Service: "ec2.amazonaws.com" },
          Action: "sts:AssumeRole",
        }),
      ],
      OWN,
    );
    expect(edges).toEqual([]);
  });

  it("finds a resource policy granting another account, and leaves * to the public checks", () => {
    const queue = (statement: unknown): Resource => ({
      arn: `arn:aws:sqs:us-east-1:${OWN}:q`,
      kind: "SqsQueue",
      name: "q",
      region: "us-east-1",
      accountId: OWN,
      tags: {},
      properties: { policy: JSON.stringify({ Statement: [statement] }) },
      derived: {},
    });
    const grant = {
      Effect: "Allow",
      Principal: { AWS: "444444444444" },
      Action: ["sqs:SendMessage"],
    };
    expect(linkCrossAccount([queue(grant)], OWN).edges[0]).toMatchObject({
      type: "CAN_ACCESS",
      properties: { actions: ["sqs:SendMessage"] },
    });
    expect(linkCrossAccount([queue({ ...grant, Principal: "*" })], OWN).edges).toEqual([]);
  });

  it("treats a role anyone can assume as open to any account", () => {
    const { accounts } = linkCrossAccount([role("Open", assume("*"))], OWN);
    expect(accounts[0]?.name).toBe("Any AWS account");
  });
});
