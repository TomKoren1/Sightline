/**
 * No test fixture may be shaped like a real credential.
 *
 * The repository's own gitleaks rules are the authority on what "looks real", and
 * a fixture that matches one fails the secret scan — which happened here, on a fake
 * Anthropic key written into a masking test. The shape was irrelevant to what that
 * test asserted, so the cost was a CI run; the danger is that a scanner which cries
 * wolf stops being read.
 *
 * This applies the same patterns in the unit suite, so the feedback arrives while
 * the fixture is being written rather than minutes later in CI. It is not a
 * replacement for gitleaks — that scans history and carries far more rules — it is
 * the fast half.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../../", import.meta.url));

/** Files git tracks, so generated output and node_modules are out of scope. */
function trackedSourceFiles(): string[] {
  const out = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8" });
  return (
    out
      .split("\0")
      .filter(Boolean)
      .filter((f) => /\.(ts|tsx|js|cjs|mjs|json|md|ya?ml)$/.test(f))
      // Allowlisted in .gitleaks.toml for the same reason they are here: both
      // exist in order to *describe* secrets.
      .filter((f) => f !== ".env.example" && f !== ".gitleaks.toml")
  );
}

interface Rule {
  id: string;
  regex: RegExp;
  /** Lines the rule deliberately permits, from its own `[rules.allowlist]`. */
  allowed: RegExp[];
}

/**
 * Translate a RE2 pattern into a JS one.
 *
 * The only difference these rules exercise is the inline `(?i)` flag, which Go
 * supports and JS rejects with "Invalid group". Anything else unsupported throws
 * here rather than being skipped, which is the right failure: a rule this cannot
 * read is a rule it must not claim to have checked.
 */
function toJsRegex(pattern: string, flags: string): RegExp {
  const insensitive = pattern.startsWith("(?i)");
  return new RegExp(insensitive ? pattern.slice(4) : pattern, insensitive ? `${flags}i` : flags);
}

/**
 * The rules, read from `.gitleaks.toml` rather than restated.
 *
 * Restating them would be a second copy that drifts — the failure this project has
 * logged four times. A rule added there is picked up here for free.
 */
function gitleaksRules(): Rule[] {
  const config = readFileSync(`${root}.gitleaks.toml`, "utf8");
  const tripleQuoted = /'{3}([\s\S]*?)'{3}/;
  const rules: Rule[] = [];

  for (const block of config.split(/^\[\[rules\]\]$/m).slice(1)) {
    const id = /^id\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    const regexLine = /^regex\s*=\s*(.*)$/m.exec(block)?.[1];
    if (!id || !regexLine) continue;
    const pattern = tripleQuoted.exec(regexLine)?.[1];
    if (!pattern) continue;

    /**
     * The rule's own allowlist is honoured, or this flags the placeholders the
     * config explicitly permits — and a check that fires on documented
     * placeholders is one nobody keeps.
     */
    const allowBlock = /\[rules\.allowlist\]([\s\S]*?)(?=\n\[|$)/.exec(block)?.[1] ?? "";
    const allowed = [...allowBlock.matchAll(/'{3}([\s\S]*?)'{3}/g)].map((m) =>
      toJsRegex(m[1]!, ""),
    );

    rules.push({ id, regex: toJsRegex(pattern, "g"), allowed });
  }
  return rules;
}

/**
 * Findings for one file's lines. Extracted so it can be run against a planted
 * secret, not only against a tree that is expected to be clean.
 *
 * Without that, suppressing every finding passes: there is nothing to suppress in
 * a clean repository, so the assertion cannot tell a working scan from a disabled
 * one. A guard needs a positive control.
 */
function scanLines(file: string, lines: string[], rules: Rule[]): string[] {
  const findings: string[] = [];
  for (const { id, regex, allowed } of rules) {
    for (const [n, line] of lines.entries()) {
      regex.lastIndex = 0;
      if (!regex.test(line)) continue;
      if (allowed.some((a) => a.test(line))) continue;
      findings.push(`${file}:${n + 1} matches ${id}`);
    }
  }
  return findings;
}

describe("the scan itself detects what it should", () => {
  it("finds a planted Anthropic key", () => {
    const found = scanLines(
      "planted.ts",
      ['const k = "sk-ant-aaaaaaaaaaaaaaaaaaaaaa";'],
      gitleaksRules(),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("anthropic-api-key");
  });

  it("finds a planted ExternalId", () => {
    const found = scanLines(
      "planted.env",
      ["AWS_EXTERNAL_ID=daveio-ARealLookingSecret1"],
      gitleaksRules(),
    );
    expect(found.some((f) => f.includes("daveio-external-id"))).toBe(true);
  });

  it("honours the rule's own allowlist for documented placeholders", () => {
    // A check that fires on the placeholders the config permits is one nobody keeps.
    for (const line of [
      "AWS_EXTERNAL_ID=replace-me-per-customer",
      "AWS_EXTERNAL_ID=local-dev-external-id-0000",
    ]) {
      expect(scanLines("planted.env", [line], gitleaksRules()), line).toEqual([]);
    }
  });

  it("reports the line number, so a finding can be found", () => {
    const found = scanLines("f.ts", ["ok", "ok", "sk-ant-aaaaaaaaaaaaaaaaaaaaaa"], gitleaksRules());
    expect(found[0]).toContain("f.ts:3");
  });
});

describe("no source file carries a credential-shaped string", () => {
  it("parsed the rules out of .gitleaks.toml, and can use them", () => {
    // Guards the guard: a parser that finds nothing would pass everything.
    const rules = gitleaksRules();
    expect(rules.length, "no rules were parsed from .gitleaks.toml").toBeGreaterThan(1);
    expect(rules.map((r) => r.id)).toContain("anthropic-api-key");

    const anthropic = rules.find((r) => r.id === "anthropic-api-key")!;
    anthropic.regex.lastIndex = 0;
    expect(anthropic.regex.test("sk-ant-aaaaaaaaaaaaaaaaaaaaaa")).toBe(true);
  });

  it("matches nothing in tracked sources", () => {
    const rules = gitleaksRules();
    const findings: string[] = [];
    for (const file of trackedSourceFiles()) {
      findings.push(...scanLines(file, readFileSync(root + file, "utf8").split("\n"), rules));
    }
    expect(findings, `credential-shaped strings found:\n  ${findings.join("\n  ")}`).toEqual([]);
  });
});
