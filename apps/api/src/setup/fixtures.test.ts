/**
 * No source file may carry a credential-shaped string.
 *
 * The repository's own gitleaks rules are the authority on what "looks real", and a
 * fixture that matches one fails the secret scan — which happened twice while
 * writing this. First on a fake Anthropic key in a masking test, where the shape
 * was irrelevant to the assertion. Then on **this file's own positive controls**,
 * which is the more interesting failure: a test that proves it detects
 * credential-shaped strings needs one to detect.
 *
 * Both are fixed the same way — assemble probes at run time — and the reason is
 * recorded beside them, because a literal reads as simpler and would be restored by
 * the next person to tidy this up.
 *
 * This is the fast half of the secret scan, not a replacement: gitleaks reads git
 * history and carries far more rules. What this adds is feedback while the fixture
 * is being written rather than minutes later in CI.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../../", import.meta.url));

/**
 * Files git tracks **or would track**, so build output and node_modules are out of
 * scope but a brand-new file is not.
 *
 * `--others --exclude-standard` is the important half. With `ls-files` alone this
 * could not see a file that had not been committed yet, which is precisely how it
 * missed its own fixtures: the suite passed locally before the commit, and gitleaks
 * found them in CI a minute later.
 */
function sourceFiles(): string[] {
  const out = execFileSync(
    "git",
    ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { encoding: "utf8" },
  );
  return (
    out
      .split("\0")
      .filter(Boolean)
      .filter((f) => /\.(ts|tsx|js|cjs|mjs|json|md|ya?ml)$/.test(f))
      // Allowlisted in .gitleaks.toml for the same reason they are skipped here:
      // both exist in order to *describe* secrets.
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
 * here rather than being skipped silently — a rule this cannot read is one it must
 * not claim to have checked.
 */
function toJsRegex(pattern: string, flags: string): RegExp {
  const insensitive = pattern.startsWith("(?i)");
  return new RegExp(insensitive ? pattern.slice(4) : pattern, insensitive ? `${flags}i` : flags);
}

/**
 * The rules, read from `.gitleaks.toml` rather than restated.
 *
 * A restated copy is the drift this project's log has four entries about. A rule
 * added there is picked up here for free.
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

    // The rule's own allowlist is honoured, or this flags the placeholders the
    // config explicitly permits — and a check that fires on documented
    // placeholders is one nobody keeps.
    const allowBlock = /\[rules\.allowlist\]([\s\S]*?)(?=\n\[|$)/.exec(block)?.[1] ?? "";
    const allowed = [...allowBlock.matchAll(/'{3}([\s\S]*?)'{3}/g)].map((m) =>
      toJsRegex(m[1]!, ""),
    );

    rules.push({ id, regex: toJsRegex(pattern, "g"), allowed });
  }
  return rules;
}

/**
 * Findings for one file's lines.
 *
 * Extracted so it can run against a planted secret, not only against a tree
 * expected to be clean. Without that, suppressing every finding passes — there is
 * nothing to suppress in a clean repository, so the assertion cannot tell a working
 * scan from a disabled one.
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

/**
 * Probes assembled at run time, never written as literals.
 *
 * Not squeamishness — necessity. Written as literals, these lines match the rules
 * this file mirrors, so gitleaks flags this file and the scan fails forever.
 * Allowlisting the file instead would mean a real secret here went unseen.
 * Concatenation is enough because both scanners read text.
 *
 * **Do not fold these back into literals.**
 */
const PROBE = {
  anthropicKey: () => ["sk", "ant", "a".repeat(22)].join("-"),
  externalId: () => `AWS_EXTERNAL_ID=${["daveio", "A".repeat(20)].join("-")}`,
};

describe("the scan detects what it should", () => {
  it("parsed the rules, and can use them", () => {
    // Guards the guard: a parser that finds nothing would pass everything.
    const rules = gitleaksRules();
    expect(rules.length, "no rules were parsed from .gitleaks.toml").toBeGreaterThan(1);
    expect(rules.map((r) => r.id)).toContain("anthropic-api-key");
  });

  it("finds a planted Anthropic key", () => {
    const found = scanLines(
      "planted.ts",
      [`const k = "${PROBE.anthropicKey()}";`],
      gitleaksRules(),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("anthropic-api-key");
  });

  it("finds a planted ExternalId", () => {
    const found = scanLines("planted.env", [PROBE.externalId()], gitleaksRules());
    expect(found.some((f) => f.includes("daveio-external-id"))).toBe(true);
  });

  it("honours the rule's own allowlist for documented placeholders", () => {
    for (const line of [
      "AWS_EXTERNAL_ID=replace-me-per-customer",
      "AWS_EXTERNAL_ID=local-dev-external-id-0000",
    ]) {
      expect(scanLines("planted.env", [line], gitleaksRules()), line).toEqual([]);
    }
  });

  it("reports the line number, so a finding can be found", () => {
    const found = scanLines("f.ts", ["ok", "ok", PROBE.anthropicKey()], gitleaksRules());
    expect(found[0]).toContain("f.ts:3");
  });
});

describe("no source file carries a credential-shaped string", () => {
  it("matches nothing in the repository", () => {
    const rules = gitleaksRules();
    const findings: string[] = [];
    for (const file of sourceFiles()) {
      findings.push(...scanLines(file, readFileSync(root + file, "utf8").split("\n"), rules));
    }
    expect(findings, `credential-shaped strings found:\n  ${findings.join("\n  ")}`).toEqual([]);
  });
});
