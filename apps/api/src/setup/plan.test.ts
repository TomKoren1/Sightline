/**
 * What the setup script decides, tested without prompting or touching AWS.
 *
 * The script's safety promises live here: it writes only declared keys, never a
 * credential, never prints one, and re-running does not rotate a working secret.
 * Each of those is a property rather than a code path, so each gets an assertion.
 */

import { describe, expect, it } from "vitest";
import { CONNECTION_ENV_KEYS, OTHER_MANAGED_ENV_KEYS, readOnlyRoleArn } from "@sightline/shared";

import {
  chooseExternalId,
  composeMountEdits,
  maskForDisplay,
  mockConnectionEdits,
  PLACEHOLDER_EXTERNAL_ID,
  realConnectionEdits,
  undeclaredEdits,
  WRITABLE_KEYS,
} from "./plan.js";

const input = {
  accountId: "672299759593",
  region: "us-east-1",
  externalId: "sightline-JSPwaNtDbq9dA1HFtwzppjaG",
  scanRegions: "",
};

describe("maskForDisplay", () => {
  it("masks the ExternalId, which the role template calls a credential", () => {
    const masked = maskForDisplay("AWS_EXTERNAL_ID", input.externalId);
    expect(masked).not.toBe(input.externalId);
    // Enough to tell two values apart, and no more.
    expect(masked.startsWith("sigh")).toBe(true);
    expect(masked).toContain("•");
  });

  it("masks the LLM key", () => {
    /**
     * Deliberately not shaped like a real key.
     *
     * The first version of this used `sk-ant-api03-…`, which the repository's own
     * gitleaks rule matches — so the secret scan failed on a fixture. The shape is
     * irrelevant to what is being tested: masking is decided by the variable
     * *name*, not by whether the value looks like a credential. A fixture that
     * trips the scanner costs a CI run and teaches the reader to ignore it.
     */
    const fake = "definitely-not-a-real-key-0123456789";
    const masked = maskForDisplay("ANTHROPIC_API_KEY", fake);
    expect(masked).not.toContain("not-a-real-key-0123456789");
    expect(masked).toContain("•");
  });

  it("masks to a fixed width, so the secret's length is not published", () => {
    /**
     * Proportional masking printed eighty dots for a real Anthropic key: unreadable
     * in a diff, and a free measurement of the secret. Two values of very different
     * lengths must mask to the same width.
     */
    const short = maskForDisplay("ANTHROPIC_API_KEY", "abcd" + "x".repeat(20) + "wxyz");
    const long = maskForDisplay("ANTHROPIC_API_KEY", "abcd" + "x".repeat(200) + "wxyz");
    expect(short).toBe(long);
    expect(short.length).toBeLessThan(20);
    // And it still shows enough to tell two values apart.
    expect(short.startsWith("abcd")).toBe(true);
    expect(short.endsWith("wxyz")).toBe(true);
  });

  it("never leaks the middle of a short secret", () => {
    // A short value gets no window at all rather than a mostly-visible one.
    expect(maskForDisplay("AWS_EXTERNAL_ID", "abcd1234")).toBe("••••••••");
  });

  it("leaves non-secret values readable", () => {
    // The point of the diff is that the user can check it.
    const arn = readOnlyRoleArn(input.accountId);
    expect(maskForDisplay("AWS_TARGET_ROLE_ARN", arn)).toBe(arn);
    expect(maskForDisplay("AWS_MODE", "real")).toBe("real");
  });

  it("does not mask an empty value into dots", () => {
    // `ANTHROPIC_API_KEY=` is a legitimate state; showing "••" would imply a value.
    expect(maskForDisplay("ANTHROPIC_API_KEY", "")).toBe("");
  });
});

describe("chooseExternalId", () => {
  it("reuses one already in use, so re-running does not rotate it", () => {
    /**
     * The stack's trust policy requires the value `.env` holds. Generating a fresh
     * one on every run would invalidate a working connection until the stack was
     * redeployed — the script breaking the setup it had just made. Caught by
     * running --dry-run twice and seeing an ExternalId change on a deployment that
     * was already correct.
     */
    const result = chooseExternalId(input.externalId, () => "sightline-NEW");
    expect(result).toEqual({ value: input.externalId, reused: true });
  });

  it("generates when there is none", () => {
    expect(chooseExternalId(null, () => "sightline-NEW")).toEqual({
      value: "sightline-NEW",
      reused: false,
    });
  });

  it("generates when the value is empty", () => {
    expect(chooseExternalId("", () => "sightline-NEW").reused).toBe(false);
  });

  it("does not reuse the shipped placeholder", () => {
    // It is documentation, not a secret anyone chose.
    expect(chooseExternalId(PLACEHOLDER_EXTERNAL_ID, () => "sightline-NEW")).toEqual({
      value: "sightline-NEW",
      reused: false,
    });
  });

  it("respects a value the user set themselves", () => {
    // Not everything starting without the prefix is a placeholder.
    expect(chooseExternalId("my-own-shared-secret", () => "sightline-NEW").reused).toBe(true);
  });
});

describe("the edits the script produces", () => {
  it("only ever names declared keys", () => {
    for (const edits of [realConnectionEdits(input), mockConnectionEdits(), composeMountEdits()]) {
      expect(undeclaredEdits(edits)).toEqual([]);
    }
  });

  it("never writes a credential variable", () => {
    /**
     * The hard line: the script asks for a profile or leaves credentials alone, so
     * a long-lived secret is never written to a file by automation the user cannot
     * watch. Asserted over the allow-list itself, not over today's edits.
     */
    for (const key of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]) {
      expect(WRITABLE_KEYS.has(key), `${key} must never be writable`).toBe(false);
    }
  });

  it("catches a stray key before anything is written", () => {
    expect(undeclaredEdits([{ key: "DATABASE_URL", value: "postgres://evil" }])).toEqual([
      "DATABASE_URL",
    ]);
  });

  it("derives the role ARN from the account id rather than accepting one", () => {
    // Pasting the wrong ARN here is what produced `Invalid principal in policy`
    // on a real account (#46); building it removes the opportunity.
    const arn = realConnectionEdits(input).find((e) => e.key === "AWS_TARGET_ROLE_ARN");
    expect(arn!.value).toBe(readOnlyRoleArn(input.accountId));
  });

  it("switches to real mode and keeps the region it was given", () => {
    const edits = realConnectionEdits(input);
    expect(edits.find((e) => e.key === "AWS_MODE")!.value).toBe("real");
    expect(edits.find((e) => e.key === "AWS_REGION")!.value).toBe("us-east-1");
  });

  it("does not discard a connection when switching to the demo account", () => {
    /**
     * Going back to mock should not throw away a role ARN and ExternalId that took
     * effort to establish - `activeConnection()` ignores them in mock mode anyway,
     * and clearing them would make the toggle destructive.
     */
    const keys = mockConnectionEdits().map((e) => e.key);
    expect(keys).toEqual(["AWS_MODE"]);
  });

  it("sets the compose path separator explicitly, not just the file list", () => {
    // The default separator differs by platform, so a `:`-joined value is not
    // parsed the same way everywhere.
    const keys = composeMountEdits().map((e) => e.key);
    expect(keys).toContain("COMPOSE_PATH_SEPARATOR");
    expect(keys).toContain("COMPOSE_FILE");
  });
});

describe("the writable allow-list", () => {
  it("is exactly the two shared lists, so nothing is writable by accident", () => {
    expect([...WRITABLE_KEYS].sort()).toEqual(
      [...CONNECTION_ENV_KEYS, ...OTHER_MANAGED_ENV_KEYS].sort(),
    );
  });
});
