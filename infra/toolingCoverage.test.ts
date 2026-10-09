/**
 * Every TypeScript file in the repository must be both type-checked and linted.
 *
 * This exists because it was not true. `npm run typecheck` runs
 * `--workspaces`, and `infra/` is not a workspace, so the five guard tests in
 * this directory - including the ones asserting the Dockerfile copies
 * `scripts/` and that the workflows reference paths that exist - were checked
 * by nothing at all. vitest transpiles them with esbuild, which strips types
 * without reading them, so they ran green while being free to be type-broken.
 *
 * The failure is silent and it is structural: adding a directory is how you
 * reintroduce it, and nothing about adding a directory suggests you should
 * check. So the coverage is asserted rather than remembered.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path: string) => readFileSync(root + path, "utf8");

/** Directories that hold no source of our own, so nothing in them is ours to check. */
const NOT_SOURCE = new Set(["node_modules", ".git", "dist", "build", "coverage", ".github"]);

/** Every tsconfig in the repository, as repository-relative paths. */
function findTsconfigs(dir = "", depth = 0): string[] {
  if (depth > 3) return [];
  const found: string[] = [];
  for (const entry of readdirSync(root + dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (NOT_SOURCE.has(entry.name)) continue;
      found.push(...findTsconfigs(`${dir}${entry.name}/`, depth + 1));
    } else if (entry.name === "tsconfig.json") {
      found.push(`${dir}${entry.name}`);
    }
  }
  return found;
}

/**
 * The `project` globs ESLint parses type-aware rules with.
 *
 * Read out of the config as text rather than imported: importing it would
 * execute the config, which resolves every plugin, and this needs to know what
 * the file *says*.
 */
function eslintProjectGlobs(): string[] {
  const config = read("eslint.config.mjs");
  const block = /project:\s*\[([^\]]*)\]/.exec(config);
  if (!block) throw new Error("eslint.config.mjs no longer declares a `project` array");
  return [...block[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!.replace(/^\.\//, ""));
}

/** Only `*` needs supporting: every glob names one directory level, then a file. */
function globMatches(glob: string, path: string): boolean {
  const pattern = glob.split("*").map(escapeRegExp).join("[^/]*");
  return new RegExp(`^${pattern}$`).test(path);
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The root `tsconfig.json` is excluded, and only this one.
 *
 * It exists to hand esbuild `experimentalDecorators` when tsx and vitest run
 * from the repository root, and it deliberately declares no `files` or
 * `include` - with an empty one, esbuild treats every source as out of scope
 * and silently ignores the options (engineering log #55). Nothing runs `tsc`
 * against it, so it covers no files and belongs in no linter project.
 */
const NOT_A_PROJECT = new Set(["tsconfig.json", "tsconfig.base.json"]);

describe("every TypeScript project is linted", () => {
  // Called per test, not once in this block: thrown here, a missing `project`
  // array breaks collection and vitest reports "no tests" rather than a named
  // failure - which is a worse thing to read than the assertion it replaced.
  it("has at least one glob, so the assertions below can fail", () => {
    expect(eslintProjectGlobs().length).toBeGreaterThan(0);
  });

  it("covers every tsconfig that owns files", () => {
    const globs = eslintProjectGlobs();
    const projects = findTsconfigs().filter((p) => !NOT_A_PROJECT.has(p));
    const uncovered = projects.filter((p) => !globs.some((g) => globMatches(g, p)));
    expect(
      uncovered,
      "these TypeScript projects are outside ESLint's `project` list, so the " +
        "type-aware rules do not run on their files. Add a glob to " +
        "eslint.config.mjs.",
    ).toEqual([]);
  });

  /**
   * A canary. If the matcher silently matched nothing, the assertion above
   * would pass for a repository with no linting at all.
   */
  it("would notice a project that is not covered", () => {
    const globs = eslintProjectGlobs();
    expect(globs.some((g) => globMatches(g, "apps/api/tsconfig.json"))).toBe(true);
    expect(globs.some((g) => globMatches(g, "apps/newthing/tsconfig.json"))).toBe(true);
    expect(globs.some((g) => globMatches(g, "somewhere/else/tsconfig.json"))).toBe(false);
  });
});

describe("the code outside every workspace is type-checked", () => {
  it("has a tsconfig for it", () => {
    expect(existsSync(root + "tsconfig.tools.json")).toBe(true);
  });

  it("is run by npm run typecheck, which otherwise only visits workspaces", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(
      pkg.scripts["typecheck"],
      "`--workspaces` skips infra/, scripts/ and the root config files. Without " +
        "the tools project in this script they are type-checked by nothing.",
    ).toContain("tsconfig.tools.json");
  });

  it("covers each non-workspace directory that holds TypeScript", () => {
    const tools = read("tsconfig.tools.json");
    // `infra/` holds this file and five other guards; `vitest.config.ts` decides
    // which of them run at all.
    expect(tools).toContain("infra/");
    expect(tools).toContain("vitest.config.ts");
  });

  it("type-checks the plain JavaScript that cannot be TypeScript", () => {
    // `scripts/deps.mjs` runs before anything that could compile TypeScript is
    // installed, so `checkJs` is the only way it is checked at all.
    const tools = read("tsconfig.tools.json");
    expect(tools).toContain("scripts/");
    expect(JSON.parse(tools.replace(/^\s*\/\/.*$/gm, "")) as { compilerOptions: unknown }).toEqual(
      expect.objectContaining({
        compilerOptions: expect.objectContaining({ checkJs: true }),
      }),
    );
  });
});
