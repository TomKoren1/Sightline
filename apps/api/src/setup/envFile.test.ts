/**
 * The setup script edits a file the user owns, so "changes only what it declares"
 * has to be a tested property rather than an intention.
 *
 * Everything here is pure string work — no filesystem, no prompts — which is why
 * it was extracted from the script in the first place. The cases that matter are
 * the ones where a naive implementation quietly does the wrong thing: commented
 * examples that look like assignments, duplicate keys, values containing `=`, and
 * a file whose other lines must come back byte-identical.
 */

import { describe, expect, it } from "vitest";

import {
  applyEnvEdits,
  diffEnv,
  duplicateKeys,
  readEnvValue,
  SETUP_HEADING,
  untouchedKeys,
} from "./envFile.js";

const sample = [
  "# Databases",
  "DATABASE_URL=postgres://dave:dave@localhost:5432/dave",
  "NEO4J_URI=bolt://localhost:7687",
  "",
  "# AWS",
  "AWS_MODE=mock",
  "AWS_TARGET_ROLE_ARN=arn:aws:iam::123456789012:role/DaveIoReadOnlyRole",
  "# AWS_PROFILE_DIR=C:/Users/you/.aws",
  "",
  "ANTHROPIC_API_KEY=",
  "",
].join("\n");

describe("readEnvValue", () => {
  it("reads an assignment", () => {
    expect(readEnvValue(sample, "AWS_MODE")).toBe("mock");
  });

  it("reads an empty value as empty, not as absent", () => {
    // The difference matters: absent means "append it", empty means "replace it".
    expect(readEnvValue(sample, "ANTHROPIC_API_KEY")).toBe("");
  });

  it("ignores a commented-out key", () => {
    // `.env.example` is full of these. Treating one as a value would make the
    // script report an "update" to a line that was never active.
    expect(readEnvValue(sample, "AWS_PROFILE_DIR")).toBeNull();
  });

  it("returns null for a key that is not there", () => {
    expect(readEnvValue(sample, "NOT_PRESENT")).toBeNull();
  });

  it("keeps a value containing = intact", () => {
    // Base64 and connection strings both do this.
    const content = "KEY=a=b=c";
    expect(readEnvValue(content, "KEY")).toBe("a=b=c");
  });
});

describe("duplicateKeys", () => {
  it("finds a key assigned twice", () => {
    // A file with two AWS_MODE lines behaves unpredictably to a reader, so the
    // script refuses rather than picking one.
    expect(duplicateKeys("AWS_MODE=mock\nAWS_MODE=real\n")).toEqual(["AWS_MODE"]);
  });

  it("does not count a commented duplicate", () => {
    expect(duplicateKeys("AWS_MODE=mock\n# AWS_MODE=real\n")).toEqual([]);
  });

  it("is empty for a clean file", () => {
    expect(duplicateKeys(sample)).toEqual([]);
  });
});

describe("diffEnv", () => {
  it("classifies add, update and unchanged", () => {
    const diff = diffEnv(sample, [
      { key: "AWS_MODE", value: "real" },
      { key: "AWS_REGION", value: "us-east-1" },
      { key: "NEO4J_URI", value: "bolt://localhost:7687" },
    ]);
    expect(diff.map((d) => [d.key, d.kind])).toEqual([
      ["AWS_MODE", "update"],
      ["AWS_REGION", "add"],
      ["NEO4J_URI", "unchanged"],
    ]);
  });

  it("reports the previous value, so the user sees what they are losing", () => {
    const [entry] = diffEnv(sample, [{ key: "AWS_MODE", value: "real" }]);
    expect(entry!.before).toBe("mock");
    expect(entry!.after).toBe("real");
  });
});

describe("applyEnvEdits", () => {
  it("replaces a key in place, keeping its position", () => {
    const out = applyEnvEdits(sample, [{ key: "AWS_MODE", value: "real" }]);
    const lines = out.split("\n");
    expect(lines.indexOf("AWS_MODE=real")).toBe(sample.split("\n").indexOf("AWS_MODE=mock"));
  });

  it("changes nothing else at all", () => {
    const out = applyEnvEdits(sample, [{ key: "AWS_MODE", value: "real" }]);
    const before = sample.split("\n");
    const after = out.split("\n");
    for (let i = 0; i < before.length; i++) {
      if (before[i] === "AWS_MODE=mock") continue;
      expect(after[i], `line ${i} changed`).toBe(before[i]);
    }
  });

  it("appends an unknown key under a labelled heading", () => {
    const out = applyEnvEdits(sample, [{ key: "AWS_REGION", value: "eu-west-1" }]);
    expect(out).toContain("# --- written by `npm run setup` ---");
    expect(out).toContain("AWS_REGION=eu-west-1");
    // And the original content is still intact above it.
    expect(out.startsWith("# Databases\nDATABASE_URL=")).toBe(true);
  });

  it("leaves a commented-out key commented, and appends instead", () => {
    /**
     * Uncommenting a line the user commented out is a decision, and the value
     * beside it is usually an example rather than something they chose - here a
     * Windows path that would break Compose under WSL.
     */
    const out = applyEnvEdits(sample, [{ key: "AWS_PROFILE_DIR", value: "/home/tom/.aws" }]);
    expect(out).toContain("# AWS_PROFILE_DIR=C:/Users/you/.aws");
    expect(out).toContain("AWS_PROFILE_DIR=/home/tom/.aws");
  });

  it("is idempotent", () => {
    const edits = [
      { key: "AWS_MODE", value: "real" },
      { key: "AWS_REGION", value: "us-east-1" },
    ];
    const once = applyEnvEdits(sample, edits);
    expect(applyEnvEdits(once, edits)).toBe(once);
  });

  it("does not accumulate headings on repeated runs", () => {
    // Found by this test: a second run adding a different key appended a second
    // heading, so a user's file grew one block per run. Nothing broke, which is
    // exactly why it would have gone unnoticed.
    const first = applyEnvEdits(sample, [{ key: "AWS_REGION", value: "us-east-1" }]);
    const second = applyEnvEdits(first, [{ key: "AWS_SCAN_REGIONS", value: "" }]);
    expect(second.match(/written by `npm run setup`/g)).toHaveLength(1);
    // Both appended keys are under it, as one block.
    expect(second).toContain("AWS_REGION=us-east-1");
    expect(second).toContain("AWS_SCAN_REGIONS=");
    const lines = second.split("\n");
    const at = lines.indexOf(SETUP_HEADING);
    const block = lines.slice(at + 1, at + 3);
    expect(
      block.every((l) => /^[A-Z_]+=/.test(l)),
      `block was ${JSON.stringify(block)}`,
    ).toBe(true);
  });

  it("preserves the presence or absence of a trailing newline", () => {
    expect(applyEnvEdits("A=1\n", [{ key: "A", value: "2" }])).toBe("A=2\n");
    expect(applyEnvEdits("A=1", [{ key: "A", value: "2" }])).toBe("A=2");
  });

  it("handles an empty file", () => {
    const out = applyEnvEdits("", [{ key: "AWS_MODE", value: "real" }]);
    expect(out).toContain("AWS_MODE=real");
  });

  it("writes a value containing = without mangling it", () => {
    const out = applyEnvEdits("KEY=old\n", [{ key: "KEY", value: "a=b=c" }]);
    expect(readEnvValue(out, "KEY")).toBe("a=b=c");
  });
});

describe("untouchedKeys", () => {
  it("is empty when only declared keys changed", () => {
    const edits = [{ key: "AWS_MODE", value: "real" }];
    const after = applyEnvEdits(sample, edits);
    expect(untouchedKeys(sample, after, edits)).toEqual([]);
  });

  it("names a key that changed without being declared", () => {
    // The backstop: if applyEnvEdits ever damages an unrelated line, the script
    // refuses to write rather than trusting the implementation above.
    const damaged = sample.replace("NEO4J_URI=bolt://localhost:7687", "NEO4J_URI=broken");
    expect(untouchedKeys(sample, damaged, [{ key: "AWS_MODE", value: "real" }])).toEqual([
      "NEO4J_URI",
    ]);
  });

  it("notices a key that was deleted entirely", () => {
    const damaged = sample.replace("NEO4J_URI=bolt://localhost:7687\n", "");
    expect(untouchedKeys(sample, damaged, [])).toContain("NEO4J_URI");
  });
});
