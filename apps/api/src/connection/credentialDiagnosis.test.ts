/**
 * "No source credentials were found" has to say which link of the chain is missing.
 *
 * That message is accurate and was useless. It was reported by a reader following
 * the onboarding steps on a fresh machine, and it has at least three distinct
 * causes needing different fixes:
 *
 *   - no keys in the environment and no profile mounted
 *   - the mock's placeholder still in AWS_ACCESS_KEY_ID, which is stripped to
 *     stop it shadowing the rest of the chain
 *   - a profile mounted from the wrong host path, which on Windows is what an
 *     unset HOME produces: the mount succeeds and the directory is empty
 *
 * None is visible from outside the container, so the reader cannot tell them
 * apart by inspection (engineering log #48).
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { fileURLToPath } from "node:url";

import {
  awsProfileDir,
  credentialSources,
  looksLikeRealAccessKey,
  MOCK_ACCESS_KEY_PLACEHOLDER,
} from "../config.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));

describe("credentialSources", () => {
  it("reports presence and shape, never a value", () => {
    const src = credentialSources();
    // A diagnosis that leaks half a secret into a UI is not an improvement, so
    // the shape of the result is part of the contract.
    expect(Object.keys(src).sort()).toEqual([
      "containerised",
      "envKeyIsMockPlaceholder",
      "envKeyLength",
      "envKeyLooksReal",
      "envKeySet",
      "profileDirExists",
      "profileFiles",
    ]);
    expect(typeof src.envKeySet).toBe("boolean");
    expect(typeof src.envKeyLooksReal).toBe("boolean");
    // File *names* are safe and useful (config, credentials); contents are not.
    for (const f of src.profileFiles) expect(typeof f).toBe("string");
  });

  it("distinguishes an empty profile directory from an absent one", () => {
    /**
     * Exercised against real directories rather than whatever the host happens
     * to have. The first version of this assertion was conditional on
     * `profileFiles.length > 0`, so on a machine with a populated ~/.aws it
     * could not detect the two states being collapsed at all - it passed while
     * the distinction was removed.
     *
     * They point at different fixes: empty means the mount landed on the wrong
     * host path (on Windows, an unset HOME), absent means no mount was
     * configured. Collapsing them sends a reader to fix the wrong thing.
     */
    const base = mkdtempSync(join(tmpdir(), "creds-"));

    // Absent: no .aws under this home at all.
    expect(existsSync(awsProfileDir(base))).toBe(false);

    // Empty: the directory exists and holds nothing - the Windows case.
    mkdirSync(awsProfileDir(base));
    expect(existsSync(awsProfileDir(base))).toBe(true);
    expect(readdirSync(awsProfileDir(base))).toEqual([]);

    // And the reporting has to tell those apart, not just the filesystem.
    const home = process.env["HOME"];
    try {
      process.env["HOME"] = base;
      const empty = credentialSources();
      expect(
        empty.profileDirExists,
        "an existing but empty directory must report as existing",
      ).toBe(true);
      expect(empty.profileFiles).toEqual([]);

      writeFileSync(join(awsProfileDir(base), "credentials"), "[default]\n");
      const populated = credentialSources();
      expect(populated.profileDirExists).toBe(true);
      expect(populated.profileFiles).toContain("credentials");
    } finally {
      if (home === undefined) delete process.env["HOME"];
      else process.env["HOME"] = home;
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("the placeholder is distinguished from a wrong value", () => {
  /**
   * "Not shaped like a real key" covered two situations needing different
   * actions, and the reader who hit this had the first one: the placeholder
   * `.env.example` ships was still in place. Telling them the *shape* was wrong
   * describes a value they never chose.
   */
  it("knows the shipped placeholder by value", () => {
    expect(MOCK_ACCESS_KEY_PLACEHOLDER).toBe("mock");
    // And it must not pass the shape check, or the stripping would never happen.
    expect(looksLikeRealAccessKey(MOCK_ACCESS_KEY_PLACEHOLDER)).toBe(false);
  });

  it("is the value .env.example actually ships, not a guess", () => {
    // If the example file changes its placeholder, this message starts naming a
    // string the reader has never seen.
    const example = readFileSync(`${root}.env.example`, "utf8");
    const m = /^AWS_ACCESS_KEY_ID=(.*)$/m.exec(example);
    expect(m, ".env.example no longer sets AWS_ACCESS_KEY_ID").toBeTruthy();
    expect(m![1]!.trim()).toBe(MOCK_ACCESS_KEY_PLACEHOLDER);
  });

  it("reports a length but never the value", () => {
    const src = credentialSources();
    expect(typeof src.envKeyLength).toBe("number");
    // An access key id is an identifier rather than a secret, and there is still
    // no reason to echo one into a UI.
    expect(Object.values(src)).not.toContain(process.env["AWS_ACCESS_KEY_ID"] ?? "\u0000");
  });
});

describe("looksLikeRealAccessKey", () => {
  /**
   * A pure function, tested with a table, because the branch that matters cannot
   * be reached through `credentialSources()`: the placeholder is deleted from
   * `process.env` at import time - that is the whole point of the stripping - so
   * an assertion conditioned on seeing it there never runs. Same reason
   * `toSourceIdentity` and `isTerminalApiError` are separate functions.
   */
  it.each([
    ["an IAM user key", "AKIAIOSFODNN7EXAMPLE", true],
    ["a temporary session key", "ASIAIOSFODNN7EXAMPLE", true],
    ["the mock's placeholder", MOCK_ACCESS_KEY_PLACEHOLDER, false],
    ["empty", "", false],
    ["undefined", undefined, false],
    ["a plausible-looking fake", "not-a-real-key-at-all", false],
    ["lowercase, so not an AWS key id", "akiaiosfodnn7example", false],
    ["the right prefix but too short", "AKIA123", false],
  ])("%s", (_label, value, expected) => {
    expect(looksLikeRealAccessKey(value)).toBe(expected);
  });
});
