import { describe, expect, it } from "vitest";

import { explainFailure } from "./runner.js";

const PERMISSIONS = ["secretsmanager:ListSecrets", "secretsmanager:GetResourcePolicy"] as const;

/** What the SDK hands us: the socket error's code arrives as `name`. */
function awsError(name: string, message: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

describe("explainFailure", () => {
  it("names the permissions to add when the role is short one", () => {
    const err = awsError("AccessDeniedException", "User is not authorized to perform ...");
    expect(explainFailure("secretsmanager", "ap-southeast-1", err, PERMISSIONS)).toBe(
      "Not permitted to read secretsmanager in ap-southeast-1. The role needs: " +
        "secretsmanager:ListSecrets, secretsmanager:GetResourcePolicy.",
    );
  });

  /**
   * The failure that prompted these cases.
   *
   * A dual-stack connect that exhausts every address throws an `AggregateError`
   * with an empty `message`, so this read `Failed to read secretsmanager in
   * ap-southeast-1:` and stopped - which sent the reader to audit a role that
   * was never the problem.
   */
  it("blames the network, not the account, and never stops at the colon", () => {
    const err = new AggregateError([
      new Error("connect ENETUNREACH 2406:da18:141:ab02::1:443"),
      new Error("connect ETIMEDOUT 52.221.68.114:443"),
    ]);
    err.name = "ETIMEDOUT";

    const text = explainFailure("secretsmanager", "ap-southeast-1", err, PERMISSIONS);
    expect(text).toContain("Could not reach secretsmanager in ap-southeast-1");
    expect(text).toContain("connect ENETUNREACH 2406:da18:141:ab02::1:443");
    expect(text).toContain("The account and the role are not implicated");
    expect(text).not.toContain("The role needs");
  });

  it("treats a failed DNS lookup the same way", () => {
    const err = awsError("EAI_AGAIN", "getaddrinfo EAI_AGAIN ecs.ap-southeast-1.amazonaws.com");
    expect(explainFailure("ecs", "ap-southeast-1", err, PERMISSIONS)).toContain(
      "Could not reach ecs in ap-southeast-1",
    );
  });

  /**
   * The property that actually went wrong, stated once over every branch: a
   * message ending in ": " tells the reader nothing and looks like a bug.
   */
  it("never renders an empty explanation, whatever it was handed", () => {
    const thrown: unknown[] = [
      new AggregateError([]),
      new Error(""),
      awsError("TimeoutError", ""),
      awsError("ETIMEDOUT", ""),
      awsError("SomethingUnheardOf", ""),
      null,
      undefined,
      "a thrown string",
      { Code: "AccessDenied" },
    ];
    for (const err of thrown) {
      const text = explainFailure("secretsmanager", "ap-southeast-1", err, PERMISSIONS);
      expect(text).not.toMatch(/[:\s]$/);
      expect(text).not.toContain(": .");
    }
  });

  it("omits the region for a global service", () => {
    const err = awsError("AccessDenied", "nope");
    expect(explainFailure("iam", null, err, ["iam:ListRoles"])).toBe(
      "Not permitted to read iam. The role needs: iam:ListRoles.",
    );
  });
});
