import type { Resource } from "@sightline/shared";
import { describe, expect, it } from "vitest";

import { parseCredentialReport, type UserCredentials } from "../collectors/iam.js";
import { analyseUnusedAccess } from "./unused.js";

const NOW = new Date("2026-10-24T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

const role = (
  properties: Record<string, unknown>,
  derived: Resource["derived"] = {},
): Resource => ({
  arn: "arn:aws:iam::111111111111:role/r",
  kind: "IamRole",
  name: "r",
  region: null,
  accountId: "111111111111",
  tags: {},
  properties: { path: "/", ...properties },
  derived,
});

const user = (credentials: UserCredentials | null, createdAt = daysAgo(400)): Resource => ({
  ...role({}),
  arn: "arn:aws:iam::111111111111:user/u",
  kind: "IamUser",
  name: "u",
  properties: { createdAt, credentials },
});

const run = (r: Resource) => {
  analyseUnusedAccess([r], NOW);
  return r.derived;
};

const noKeys: UserCredentials["accessKeys"] = [];

describe("unused roles", () => {
  it("reports one last used more than 90 days ago", () => {
    const d = run(role({ createdAt: daysAgo(500), lastUsedAt: daysAgo(120) }));
    expect(d.isUnused).toBe(true);
    expect(d.unusedReason).toMatch(/last used 120 days ago/);
  });

  it("reports one never used in the months since it was created", () => {
    expect(run(role({ createdAt: daysAgo(200), lastUsedAt: null })).unusedReason).toMatch(
      /never used in the 200 days/,
    );
  });

  it("leaves a role too new to have been unused that long", () => {
    expect(run(role({ createdAt: daysAgo(30), lastUsedAt: null })).isUnused).toBe(false);
  });

  it("leaves a role used last week", () => {
    expect(run(role({ createdAt: daysAgo(900), lastUsedAt: daysAgo(7) })).isUnused).toBe(false);
  });

  it("skips service-linked roles, which belong to AWS", () => {
    const d = run(role({ path: "/aws-service-role/ecs.amazonaws.com/", createdAt: daysAgo(900) }));
    expect(d.isUnused).toBe(false);
  });

  it("says when the unused role is an administrator", () => {
    const d = run(role({ createdAt: daysAgo(900), lastUsedAt: null }, { isAdmin: true }));
    expect(d.unusedReason).toMatch(/administrator access/);
  });
});

describe("unused users", () => {
  it("reports an active key unused for months, and not an inactive one", () => {
    const d = run(
      user({
        passwordEnabled: false,
        passwordLastUsedAt: null,
        mfaActive: false,
        accessKeys: [
          {
            slot: 1,
            active: true,
            lastRotatedAt: daysAgo(300),
            lastUsedAt: daysAgo(150),
            lastUsedService: "s3",
          },
          {
            slot: 2,
            active: false,
            lastRotatedAt: daysAgo(300),
            lastUsedAt: null,
            lastUsedService: null,
          },
        ],
      }),
    );
    expect(d.unusedReason).toMatch(/Active access key 1 last used 150 days ago/);
    expect(d.unusedReason).not.toMatch(/key 2/);
  });

  it("reports a console password never used", () => {
    const d = run(
      user({
        passwordEnabled: true,
        passwordLastUsedAt: null,
        mfaActive: false,
        accessKeys: noKeys,
      }),
    );
    expect(d.unusedReason).toMatch(/Console password never used/);
  });

  it("leaves a user whose credentials are in use", () => {
    const d = run(
      user({
        passwordEnabled: true,
        passwordLastUsedAt: daysAgo(2),
        mfaActive: true,
        accessKeys: noKeys,
      }),
    );
    expect(d.isUnused).toBe(false);
  });

  it("never calls a user unused when the credential report was not read", () => {
    const d = run(user(null));
    expect(d.isUnused).toBeUndefined();
  });
});

describe("parseCredentialReport", () => {
  const csv = [
    "user,arn,user_creation_time,password_enabled,password_last_used,password_last_changed,password_next_rotation,mfa_active,access_key_1_active,access_key_1_last_rotated,access_key_1_last_used_date,access_key_1_last_used_region,access_key_1_last_used_service,access_key_2_active,access_key_2_last_rotated,access_key_2_last_used_date,access_key_2_last_used_region,access_key_2_last_used_service",
    "<root_account>,arn:aws:iam::111111111111:root,2020-01-01T00:00:00+00:00,not_supported,2026-01-01T00:00:00+00:00,not_supported,not_supported,true,false,N/A,N/A,N/A,N/A,false,N/A,N/A,N/A,N/A",
    "ci,arn:aws:iam::111111111111:user/ci,2024-01-01T00:00:00+00:00,false,N/A,N/A,N/A,false,true,2024-01-02T00:00:00+00:00,2026-03-01T10:00:00+00:00,us-east-1,s3,false,N/A,N/A,N/A,N/A",
  ].join("\r\n");

  it("reads users, skips the root row, and turns N/A into null", () => {
    const users = parseCredentialReport(csv);
    expect([...users.keys()]).toEqual(["ci"]);
    expect(users.get("ci")).toEqual({
      passwordEnabled: false,
      passwordLastUsedAt: null,
      mfaActive: false,
      accessKeys: [
        {
          slot: 1,
          active: true,
          lastRotatedAt: "2024-01-02T00:00:00.000Z",
          lastUsedAt: "2026-03-01T10:00:00.000Z",
          lastUsedService: "s3",
        },
        { slot: 2, active: false, lastRotatedAt: null, lastUsedAt: null, lastUsedService: null },
      ],
    });
  });
});
