/**
 * Filesystem paths derived from `import.meta.url`.
 *
 * Four files built a path with `new URL(..., import.meta.url).pathname`, which
 * is a **URL** path rather than a filesystem path. The two are identical only
 * when nothing in the path needs escaping, which is true on the machine this
 * was written on and false in two common situations:
 *
 *   Windows            -> /C:/projects/app/.env      (leading slash, drive letter)
 *   a space in a dir   -> /home/me/My%20Projects/.env
 *
 * `fs` cannot open either, so `dotenv` failed with ENOENT — silently, because
 * it was called with `quiet: true`. No variable from `.env` was ever loaded.
 * The Zod defaults happen to match `.env.example`, so everything kept working
 * except `ANTHROPIC_API_KEY`, which has no default: a Windows user was told the
 * key was not set while looking at it in their `.env`, and every other value
 * they had edited was being ignored too (engineering log #36).
 *
 * Two guards, because they catch different things. The first checks that the
 * path this module actually computes resolves to a real file. The second
 * refuses the broken idiom anywhere in the repository, including in files that
 * do not exist yet — which is the one that would have prevented all four.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ENV_FILE } from "./config.js";

describe("the .env path this module computes", () => {
  it("is an absolute filesystem path, not a URL path", () => {
    // The two failing shapes, stated directly.
    expect(ENV_FILE, "percent-encoding means this is a URL path").not.toContain("%20");
    expect(ENV_FILE, "a slash before a drive letter is a URL path").not.toMatch(/^\/[A-Za-z]:/);
  });

  /**
   * `.env` itself is gitignored and absent in CI, so the check is that the
   * path lands in the right *directory* — proven by the file that is always
   * committed next to it.
   */
  it("points at the repository root, where .env.example lives", () => {
    expect(existsSync(join(dirname(ENV_FILE), ".env.example"))).toBe(true);
  });

  it("is named .env", () => {
    expect(ENV_FILE.endsWith(".env")).toBe(true);
  });
});

/**
 * The idiom guard.
 *
 * `URL.pathname` has legitimate uses — reading a query string, routing — but
 * none of them are in this codebase, and every use of it here was a bug. A flat
 * ban is therefore both correct and the cheapest thing to enforce.
 */
describe("no source file addresses the filesystem with URL.pathname", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));

  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", "dist", ".git", "coverage"].includes(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) sourceFiles(full, out);
      else if (/\.(ts|tsx|mts|cts)$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  it("finds source files to check at all", () => {
    // Without this the suite below would pass by scanning nothing.
    expect(sourceFiles(join(root, "apps")).length).toBeGreaterThan(20);
  });

  it("uses fileURLToPath everywhere instead", () => {
    const offenders: string[] = [];
    for (const dir of ["apps", "packages", "infra"]) {
      const full = join(root, dir);
      if (!existsSync(full)) continue;
      for (const file of sourceFiles(full)) {
        const text = readFileSync(file, "utf8");
        // This test names the pattern in its own prose, so skip itself.
        if (file.endsWith("config.paths.test.ts")) continue;
        if (/import\.meta\.url\s*\)\s*\.pathname/.test(text)) {
          offenders.push(file.slice(root.length));
        }
      }
    }
    expect(
      offenders,
      "URL.pathname is a URL path and breaks on Windows and on any path needing " +
        "escaping - use fileURLToPath(new URL(...)) instead. See engineering log #36.",
    ).toEqual([]);
  });
});

/**
 * The mechanism itself, pinned so the reasoning above survives as an executable
 * statement rather than a comment nobody rechecks.
 */
describe("why URL.pathname is wrong", () => {
  it("percent-encodes a space, which fs cannot open", () => {
    const base = new URL("file:///home/me/My%20Projects/app/src/config.ts");
    expect(new URL("../../.env", base).pathname).toBe("/home/me/My%20Projects/.env");
    expect(fileURLToPath(new URL("../../.env", base))).toBe("/home/me/My Projects/.env");
  });

  it("leaves a leading slash before a Windows drive letter", () => {
    const base = new URL("file:///C:/projects/app/src/config.ts");
    expect(new URL("../../.env", base).pathname).toMatch(/^\/[A-Za-z]:/);
  });
});
