/**
 * Every TypeScript file must be both type-checked and linted.
 *
 * It was not true: `npm run typecheck` runs `--workspaces`, and `infra/` is not
 * a workspace, so the guards in this directory were checked by nothing. Adding
 * a directory is how you reintroduce that, and nothing about adding one
 * suggests you should check — so the coverage is asserted rather than
 * remembered.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path: string) => readFileSync(root + path, "utf8");

const NOT_SOURCE = new Set(["node_modules", ".git", "dist", "build", "coverage", ".github"]);

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

/** Read as text, not imported: importing would execute the config and resolve every plugin. */
function eslintProjectGlobs(): string[] {
  const block = /project:\s*\[([^\]]*)\]/.exec(read("eslint.config.mjs"));
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
 * The root `tsconfig.json` owns no files — it exists to hand esbuild
 * `experimentalDecorators` and deliberately declares no `include`
 * (engineering log #55), so it belongs in no linter project.
 */
const NOT_A_PROJECT = new Set(["tsconfig.json", "tsconfig.base.json"]);

describe("every TypeScript project is linted", () => {
  // Called per test: thrown in the describe body, a missing array breaks
  // collection and vitest reports "no tests" rather than a named failure.
  it("has at least one glob, so the assertions below can fail", () => {
    expect(eslintProjectGlobs().length).toBeGreaterThan(0);
  });

  it("covers every tsconfig that owns files", () => {
    const globs = eslintProjectGlobs();
    const projects = findTsconfigs().filter((p) => !NOT_A_PROJECT.has(p));
    const uncovered = projects.filter((p) => !globs.some((g) => globMatches(g, p)));
    expect(
      uncovered,
      "these projects are outside ESLint's `project` list, so the type-aware " +
        "rules do not run on their files. Add a glob to eslint.config.mjs.",
    ).toEqual([]);
  });

  // Without this, a matcher that matched nothing would pass the assertion above.
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
      "`--workspaces` skips infra/, scripts/ and the root config files.",
    ).toContain("tsconfig.tools.json");
  });

  it("covers each non-workspace directory that holds TypeScript", () => {
    const tools = read("tsconfig.tools.json");
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
