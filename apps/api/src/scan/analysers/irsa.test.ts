import { describe, expect, it } from "vitest";
import type { Resource } from "@sightline/shared";

import { linkIrsa } from "./irsa.js";

const PROVIDER = "oidc.eks.us-east-1.amazonaws.com/id/ABC";

const cluster = (name: string, issuer: string): Resource => ({
  arn: `arn:aws:eks:us-east-1:1:cluster/${name}`,
  kind: "EksCluster",
  name,
  region: "us-east-1",
  accountId: "1",
  tags: {},
  properties: { oidcIssuer: `https://${issuer}` },
  derived: {},
});

const role = (name: string, statement: Record<string, unknown>): Resource => ({
  arn: `arn:aws:iam::1:role/${name}`,
  kind: "IamRole",
  name,
  region: null,
  accountId: "1",
  tags: {},
  properties: { trustPolicy: { Version: "2012-10-17", Statement: [statement] } },
  derived: {},
});

const trust = (
  condition?: Record<string, Record<string, string | string[]>>,
  provider = PROVIDER,
) => ({
  Effect: "Allow",
  Principal: { Federated: `arn:aws:iam::1:oidc-provider/${provider}` },
  Action: "sts:AssumeRoleWithWebIdentity",
  ...(condition ? { Condition: condition } : {}),
});

describe("linkIrsa", () => {
  it("names the service account a scoped trust policy admits", () => {
    const edges = linkIrsa([
      cluster("prod", PROVIDER),
      role(
        "Orders",
        trust({ StringEquals: { [`${PROVIDER}:sub`]: "system:serviceaccount:orders:api" } }),
      ),
    ]);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      type: "CAN_ASSUME",
      properties: { serviceAccounts: ["orders/api"] },
    });
  });

  it("calls out a trust policy that checks the audience and not the service account", () => {
    const [edge] = linkIrsa([
      cluster("prod", PROVIDER),
      role("Wide", trust({ StringEquals: { [`${PROVIDER}:aud`]: "sts.amazonaws.com" } })),
    ]);
    expect(edge?.properties?.["serviceAccounts"]).toEqual(["*"]);
    expect(edge?.properties?.["reason"]).toContain("any pod in the cluster");
  });

  it("keeps a wildcard pattern as written", () => {
    const [edge] = linkIrsa([
      cluster("prod", PROVIDER),
      role(
        "Team",
        trust({ StringLike: { [`${PROVIDER}:sub`]: "system:serviceaccount:payments:*" } }),
      ),
    ]);
    expect(edge?.properties?.["serviceAccounts"]).toEqual(["payments/*"]);
  });

  it("ignores roles trusting another cluster's provider, and denials", () => {
    const other = "oidc.eks.us-east-1.amazonaws.com/id/XYZ";
    const edges = linkIrsa([
      cluster("prod", PROVIDER),
      role("Elsewhere", trust(undefined, other)),
      role("Denied", { ...trust(), Effect: "Deny" }),
      role("Ec2", {
        Effect: "Allow",
        Principal: { Service: "ec2.amazonaws.com" },
        Action: "sts:AssumeRole",
      }),
    ]);
    expect(edges).toEqual([]);
  });
});
