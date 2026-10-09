/**
 * Remediation tests.
 *
 * Two things are being checked, and the second matters more.
 *
 * That the commands are correct — right flags, right identifiers, properly
 * quoted — because these get pasted into production accounts.
 *
 * And that the **framing** is correct: that a bucket which is merely
 * unprotected is not presented with the same urgency as one that is genuinely
 * public, that a database flagged public but unreachable says so, and that
 * every single remediation states what it might break. Those are the
 * distinctions the rest of the project is built on, and a remediation feature
 * that flattens them would undo ADR-012 at the last step.
 */

import { describe, expect, it } from "vitest";
import { shellQuote } from "@sightline/shared";

import { remediationsFor, type RemediationInput } from "./remediation.js";

function resource(over: Partial<RemediationInput>): RemediationInput {
  return {
    arn: "arn:aws:s3:::example",
    kind: "S3Bucket",
    name: "example",
    region: "us-east-1",
    properties: {},
    derived: {},
    ...over,
  };
}

describe("the contract every remediation keeps", () => {
  const samples: RemediationInput[] = [
    resource({ name: "public-bucket", derived: { isPublic: true }, properties: { policy: "{}" } }),
    resource({
      name: "unprotected-bucket",
      derived: { isUnprotected: true },
      properties: { publicAccessBlock: { BlockPublicPolicy: false } },
    }),
    resource({
      kind: "IamRole",
      name: "AdminRole",
      region: null,
      arn: "arn:aws:iam::123456789012:role/AdminRole",
      derived: { isAdmin: true },
      properties: {
        attachedPolicies: [
          {
            policyArn: "arn:aws:iam::aws:policy/AdministratorAccess",
            policyName: "AdministratorAccess",
          },
        ],
      },
    }),
    resource({
      kind: "SecurityGroup",
      name: "bastion-sg",
      properties: {
        groupId: "sg-123",
        ingress: [{ protocol: "tcp", fromPort: 22, toPort: 22, source: "cidr", cidr: "0.0.0.0/0" }],
      },
    }),
    resource({
      kind: "EbsVolume",
      name: "orphan",
      derived: { isIdle: true, estimatedMonthlyCostUsd: 8 },
      properties: { volumeId: "vol-1" },
    }),
  ];

  it("always states what could break", () => {
    for (const input of samples) {
      const remediations = remediationsFor(input);
      expect(remediations.length, input.name).toBeGreaterThan(0);
      for (const r of remediations) {
        expect(r.caution, `${input.name}/${r.id} must state a blast radius`).toBeTruthy();
        expect(r.caution.length, `${input.name}/${r.id} caution is too thin`).toBeGreaterThan(40);
      }
    }
  });

  it("always gives a read-only way to confirm the change", () => {
    for (const input of samples) {
      for (const r of remediationsFor(input)) {
        expect(r.verify, `${r.id}`).toBeTruthy();
        // A verify command must not itself mutate.
        expect(r.verify!).toMatch(/\b(describe|get|list)-/);
      }
    }
  });

  it("never emits an empty or placeholder command", () => {
    for (const input of samples) {
      for (const r of remediationsFor(input)) {
        expect(r.cli.length).toBeGreaterThan(0);
        for (const line of r.cli) expect(line.trim()).not.toBe("");
      }
    }
  });
});

describe("S3", () => {
  it("offers both the blunt and the precise fix for a public bucket", () => {
    const r = remediationsFor(
      resource({
        name: "northwind-public-assets",
        derived: { isPublic: true },
        properties: { policy: "{}" },
      }),
    );
    expect(r.map((x) => x.id)).toEqual([
      "s3-enable-block-public-access",
      "s3-remove-public-policy-statement",
    ]);
  });

  it("does not offer a policy edit when there is no policy", () => {
    const r = remediationsFor(
      resource({ derived: { isPublic: true }, properties: { policy: null } }),
    );
    expect(r.map((x) => x.id)).toEqual(["s3-enable-block-public-access"]);
  });

  /**
   * The distinction ADR-012 exists for, carried into remediation. Rating an
   * unprotected bucket "high" next to a genuinely public one would train people
   * to ignore the rating.
   */
  it("rates an unprotected bucket low, and says why it cannot break access", () => {
    const [r] = remediationsFor(
      resource({
        derived: { isUnprotected: true },
        properties: {
          publicAccessBlock: { BlockPublicPolicy: false, RestrictPublicBuckets: false },
        },
      }),
    );
    expect(r!.risk).toBe("low");
    expect(r!.caution).toMatch(/no anonymous access exists to lose/i);
  });

  it("rates a genuinely public bucket high", () => {
    const [r] = remediationsFor(resource({ derived: { isPublic: true } }));
    expect(r!.risk).toBe("high");
  });

  it("names the specific settings that are off", () => {
    const [r] = remediationsFor(
      resource({
        derived: { isUnprotected: true },
        properties: { publicAccessBlock: { BlockPublicPolicy: false } },
      }),
    );
    expect(r!.summary).toContain("BlockPublicPolicy");
  });

  it("produces nothing for a healthy bucket", () => {
    expect(
      remediationsFor(resource({ derived: { isPublic: false, isUnprotected: false } })),
    ).toEqual([]);
  });
});

describe("IAM", () => {
  const adminRole = resource({
    kind: "IamRole",
    name: "LegacyDeployRole",
    region: null,
    arn: "arn:aws:iam::123456789012:role/LegacyDeployRole",
    derived: { isAdmin: true },
    properties: { inlinePolicies: [{ policyName: "DeployHelper" }] },
  });

  /**
   * The inline-admin trap. A remediation that detached `AdministratorAccess`
   * here would look like it worked and change nothing, because the grant is in
   * a policy with an innocuous name.
   */
  it("targets the inline policy that actually grants admin", () => {
    const r = remediationsFor(adminRole);
    expect(r).toHaveLength(1);
    expect(r[0]!.id).toBe("iam-inline-DeployHelper");
    expect(r[0]!.cli.join("\n")).toContain("--policy-name DeployHelper");
  });

  it("backs up the inline policy before replacing it", () => {
    const [r] = remediationsFor(adminRole);
    expect(r!.cli[0]).toMatch(/get-role-policy/);
    expect(r!.cli.join("\n")).toContain("backup.json");
  });

  it("names the resources that will lose permissions", () => {
    const [r] = remediationsFor({
      ...adminRole,
      usedBy: [{ name: "legacy-image-resizer", kind: "LambdaFunction" }],
    });
    expect(r!.caution).toContain("legacy-image-resizer");
  });

  it("tells the truth about an unused role versus an unused user", () => {
    const role = remediationsFor(adminRole)[0]!;
    expect(role.caution).toMatch(/inventory only sees what it can enumerate/i);

    const user = remediationsFor({
      ...adminRole,
      kind: "IamUser",
      name: "ci-deploy",
      properties: { inlinePolicies: [{ policyName: "DeployHelper" }] },
    })[0]!;
    // For a user, "nothing uses it" is not evidence of anything (log #29).
    expect(user.caution).toMatch(/long-lived|not evidence it is unused/i);
  });

  it("adds a credential-rotation step for users only", () => {
    const roleIds = remediationsFor(adminRole).map((r) => r.id);
    expect(roleIds).not.toContain("iam-user-audit-keys");

    const userIds = remediationsFor({ ...adminRole, kind: "IamUser", name: "ci-deploy" }).map(
      (r) => r.id,
    );
    expect(userIds).toContain("iam-user-audit-keys");
  });

  it("uses the user-flavoured CLI verbs for a user", () => {
    const r = remediationsFor({
      ...adminRole,
      kind: "IamUser",
      name: "ci-deploy",
      properties: {
        attachedPolicies: [{ policyArn: "arn:aws:iam::aws:policy/AdministratorAccess" }],
      },
    });
    const detach = r.find((x) => x.id.startsWith("iam-detach"))!;
    expect(detach.cli.join("\n")).toContain("detach-user-policy --user-name ci-deploy");
  });

  it("ignores a scoped policy", () => {
    expect(
      remediationsFor({
        ...adminRole,
        derived: { isAdmin: false },
      }),
    ).toEqual([]);
  });
});

describe("security groups", () => {
  const sg = resource({
    kind: "SecurityGroup",
    name: "prod-bastion-sg",
    properties: {
      groupId: "sg-abc",
      ingress: [
        { protocol: "tcp", fromPort: 22, toPort: 22, source: "cidr", cidr: "0.0.0.0/0" },
        { protocol: "tcp", fromPort: 443, toPort: 443, source: "cidr", cidr: "10.0.0.0/8" },
        {
          protocol: "tcp",
          fromPort: 5432,
          toPort: 5432,
          source: "securityGroup",
          groupId: "sg-app",
        },
      ],
    },
  });

  it("revokes only the rule open to the whole internet", () => {
    const r = remediationsFor(sg);
    expect(r).toHaveLength(1);
    expect(r[0]!.title).toContain("tcp/22");
  });

  /** Revoking before adding a replacement is how people lock themselves out. */
  it("adds the narrow rule before revoking the open one", () => {
    const [r] = remediationsFor(sg);
    const joined = r!.cli.join("\n");
    expect(joined.indexOf("authorize-security-group-ingress")).toBeLessThan(
      joined.indexOf("revoke-security-group-ingress"),
    );
  });

  it("carries the region, since security groups are regional", () => {
    const [r] = remediationsFor(sg);
    expect(r!.cli.join("\n")).toContain("--region us-east-1");
  });

  it("ignores an all-traffic rule rather than emitting a malformed command", () => {
    const r = remediationsFor({
      ...sg,
      properties: {
        groupId: "sg-abc",
        ingress: [
          { protocol: "-1", fromPort: null, toPort: null, source: "cidr", cidr: "0.0.0.0/0" },
        ],
      },
    });
    expect(r).toEqual([]);
  });
});

describe("idle spend", () => {
  it("snapshots before deleting a volume, and says the snapshot is the only copy", () => {
    const [r] = remediationsFor(
      resource({
        kind: "EbsVolume",
        name: "orphaned-vol-1",
        derived: { isIdle: true, estimatedMonthlyCostUsd: 8 },
        properties: { volumeId: "vol-1" },
      }),
    );
    expect(r!.cli[0]).toContain("create-snapshot");
    expect(r!.cli.join("\n")).toContain("delete-volume");
    expect(r!.caution).toMatch(/irreversible/i);
    expect(r!.summary).toContain("$8/month");
  });

  it("warns that a released Elastic IP is not recoverable", () => {
    const [r] = remediationsFor(
      resource({
        kind: "ElasticIp",
        name: "orphaned-eip",
        derived: { isIdle: true, estimatedMonthlyCostUsd: 3.65 },
        properties: { allocationId: "eipalloc-1" },
      }),
    );
    expect(r!.cli.join("\n")).toContain(
      "release-address --region us-east-1 --allocation-id eipalloc-1",
    );
    expect(r!.caution).toMatch(/gone for good|will not get the same one back/i);
  });

  it("warns that deleting a NAT gateway removes egress", () => {
    const [r] = remediationsFor(
      resource({
        kind: "NatGateway",
        name: "legacy-nat",
        derived: { isIdle: true },
        properties: { natGatewayId: "nat-1" },
      }),
    );
    expect(r!.caution).toMatch(/outbound internet access/i);
  });

  it("produces nothing for a resource that is not idle", () => {
    expect(remediationsFor(resource({ kind: "EbsVolume", derived: { isIdle: false } }))).toEqual(
      [],
    );
  });
});

describe("RDS", () => {
  const base = {
    kind: "RdsInstance",
    region: "us-east-1",
    properties: { publiclyAccessible: true, dbInstanceIdentifier: "analytics-db" },
  };

  /**
   * The fixture's trap, and the framing that makes this feature honest rather
   * than alarmist: flagged public, reachable by nothing.
   */
  it("says a publicly-flagged but unreachable database is not an active exposure", () => {
    const [r] = remediationsFor(
      resource({ ...base, name: "analytics-db", derived: { isPublic: false } }),
    );
    expect(r!.risk).toBe("medium");
    expect(r!.addresses).toBe("unprotected");
    expect(r!.caution).toMatch(/nothing is reaching it that way today/i);
  });

  it("escalates when the database really is reachable", () => {
    const [r] = remediationsFor(
      resource({ ...base, name: "prod-db", derived: { isPublic: true } }),
    );
    expect(r!.risk).toBe("high");
    expect(r!.addresses).toBe("public");
    expect(r!.caution).toMatch(/loses access the moment this applies/i);
  });

  it("ignores a private instance", () => {
    expect(
      remediationsFor(resource({ ...base, properties: { publiclyAccessible: false } })),
    ).toEqual([]);
  });
});

describe("ordering and quoting", () => {
  it("puts exposure before posture before cost", () => {
    const r = remediationsFor(
      resource({
        kind: "S3Bucket",
        derived: { isPublic: true, isIdle: true, estimatedMonthlyCostUsd: 1 },
        properties: { policy: "{}" },
      }),
    );
    expect(r[0]!.addresses).toBe("public");
  });

  it("quotes a name that would otherwise break the shell", () => {
    const [r] = remediationsFor(
      resource({ name: "my bucket; rm -rf /", derived: { isPublic: true } }),
    );
    expect(r!.cli.join("\n")).toContain("'my bucket; rm -rf /'");
  });
});

describe("shellQuote", () => {
  it.each([
    ["plain", "northwind-reports", "northwind-reports"],
    ["empty", "", "''"],
    ["space", "my bucket", "'my bucket'"],
    ["semicolon", "a;b", "'a;b'"],
    ["dollar", "a$b", "'a$b'"],
  ])("%s", (_label, input, expected) => {
    expect(shellQuote(input)).toBe(expected);
  });

  /**
   * The POSIX idiom, which is not the intuitive one: a single-quoted string
   * cannot contain an escaped single quote, so the quote is *closed*, a
   * backslash-escaped quote is emitted outside it, and the quoting reopens —
   * `'it'\''s'`. Verified to round-trip through bash to `it's`. Writing the
   * intuitive `'it\'s'` instead produces a string the shell cannot parse, and
   * that string would be in a command someone pastes into a terminal.
   */
  it("escapes an embedded single quote the way a shell actually parses", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});
