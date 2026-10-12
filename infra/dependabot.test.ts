/**
 * Packages that must be upgraded together have to be in one Dependabot group.
 *
 * React's four packages were split across groups, so `react-dom` was bumped to
 * 19 while `react` stayed on 18. That resolves two copies of `@types/react`,
 * and since v19 adds `bigint` to `ReactNode` the two are not assignable -
 * twelve "cannot be used as a JSX component" errors from a dependency bump
 * nobody wrote. Neither PR was mergeable on its own.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const config = readFileSync(
  fileURLToPath(new URL("../.github/dependabot.yml", import.meta.url)),
  "utf8",
);

/** The `patterns: [...]` line of one named group. */
function groupPatterns(name: string): string[] {
  const block = new RegExp(`^ {6}${name}:\\n(?: {8}.*\\n)+`, "m").exec(config);
  expect(block, `dependabot.yml has no group called "${name}"`).toBeTruthy();
  const patterns = /patterns:\s*\n?\s*\[([^\]]*)\]/.exec(block![0]);
  expect(patterns, `the "${name}" group declares no patterns`).toBeTruthy();
  return [...patterns![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

describe("dependabot groups", () => {
  it("keeps React's four packages together", () => {
    expect(groupPatterns("react").sort()).toEqual([
      "@types/react",
      "@types/react-dom",
      "react",
      "react-dom",
    ]);
  });

  it("would notice a group that lost a package", () => {
    // A canary: if the parser returned nothing, the assertion above would
    // fail loudly rather than pass - but if it returned a constant it would not.
    expect(groupPatterns("aws-sdk")).toEqual(["@aws-sdk/*"]);
    expect(() => groupPatterns("no-such-group")).toThrow();
  });

  it("leaves majors out of every group, so they arrive one at a time", () => {
    /**
     * A dev-tooling group that swept ESLint 9 -> 10 and TypeScript 5 -> 7 into
     * one PR failed all four CI jobs and could not be reviewed piecemeal.
     * Majors are worth looking at individually; patches are not.
     */
    const groups = [...config.matchAll(/^ {6}([a-z-]+):$/gm)].map((m) => m[1]!);
    expect(groups.length, "no groups parsed out of dependabot.yml").toBeGreaterThan(3);
    for (const name of groups) {
      const block = new RegExp(`^ {6}${name}:\\n(?: {8}.*\\n)+`, "m").exec(config);
      expect(block![0], `the "${name}" group should take minor and patch only`).toContain(
        'update-types: ["minor", "patch"]',
      );
    }
  });
});
