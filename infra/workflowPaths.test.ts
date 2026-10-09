/**
 * Every repository path a workflow names has to exist. CI runs some suites by
 * path, and a path is a reference the type system cannot see.
 *
 * `resourceArn.test.ts` moved during the NestJS port and its step reported
 * `No test files found, exiting with code 1` - the lucky, loud version. The
 * quiet version is a step that tolerates a missing file, where the suite stops
 * running and nothing says so (engineering log #56).
 *
 * Paths rather than globs: a glob matching nothing is indistinguishable from
 * one that matches nothing *yet*.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const workflowDir = `${root}.github/workflows`;

/**
 * Anything that looks like a path into the repository.
 *
 * Deliberately narrow: a leading top-level directory this project actually has,
 * and an extension. A broader pattern picks up URLs, docker image tags and npm
 * package names, and a check that reports those is a check people switch off.
 */
const PATH_PATTERN =
  /\b(?:apps|packages|infra|scripts|deploy|evals)\/[A-Za-z0-9_./-]+\.[a-z]{2,4}\b/g;

/**
 * Glob patterns are not paths. CI's exclusion glob contains the substring
 * `evals/groundTruth.test.ts`, which does not exist at the root - the real file
 * is four directories down - so it was reported as missing on a correct
 * workflow. Whole tokens are dropped, not just the `*`: a partially de-globbed
 * string is the same near-path that caused the false failure.
 */
function withoutGlobs(text: string): string {
  return text
    .split(/\s+/)
    .filter((token) => !token.includes("*"))
    .join(" ");
}

interface Reference {
  workflow: string;
  line: number;
  path: string;
}

function references(): Reference[] {
  const found: Reference[] = [];
  for (const file of readdirSync(workflowDir).filter((f) => f.endsWith(".yml"))) {
    const lines = readFileSync(`${workflowDir}/${file}`, "utf8").split("\n");
    lines.forEach((text, i) => {
      for (const match of withoutGlobs(text).matchAll(PATH_PATTERN)) {
        found.push({ workflow: file, line: i + 1, path: match[0] });
      }
    });
  }
  return found;
}

describe("paths named in the GitHub workflows", () => {
  it("finds some, so the check below is checking something", () => {
    // A pattern that matched nothing would make the assertion below pass by
    // having nothing to assert about — the failure mode this whole file is
    // about, one level up.
    const found = references();
    expect(found.length, "no repository paths parsed out of the workflows").toBeGreaterThan(1);
    expect(found.map((r) => r.path)).toContain("apps/api/src/server.ts");
  });

  it("ignores glob patterns, which are not paths", () => {
    // Both halves matter: the glob must be dropped, and a real path on the same
    // line must survive - otherwise the fix for the false failure would be to
    // stop checking that line at all.
    expect(
      withoutGlobs("run: npx vitest run --exclude '**/evals/groundTruth.test.ts'"),
    ).not.toContain("evals/groundTruth.test.ts");
    expect(withoutGlobs("run: npx tsx apps/api/src/server.ts --exclude '**/x/y.ts'")).toContain(
      "apps/api/src/server.ts",
    );
  });

  it("all exist", () => {
    const missing = references()
      .filter((r) => !existsSync(`${root}${r.path}`))
      .map((r) => `${r.workflow}:${r.line} → ${r.path}`);
    expect(
      missing,
      "a workflow names a file that is not there. If it moved, update the workflow — " +
        "a step that runs a suite by path stops running it silently when the path is " +
        "wrong, and the suite looks green because it never ran.",
    ).toEqual([]);
  });
});
