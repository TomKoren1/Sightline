/**
 * Tests for the dependency guard.
 *
 * Plain JavaScript, like the file it covers: `deps.mjs` may not be TypeScript,
 * because it has to run when nothing that could compile TypeScript is installed.
 *
 * The interesting assertions are the ones about *failing* to install. A guard
 * that reports success when the tree it was asked to fix is still broken hands
 * the reader back the original unreadable error, one step later, which is worse
 * than not having run at all.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ROOT, dependenciesInstalled, installArgv, main, tsxPath } from "./deps.mjs";

/** A root with no node_modules at all: a fresh clone. */
const freshClone = () => mkdtempSync(join(tmpdir(), "deps-fresh-"));

/** A root with node_modules but no tsx: what `npm ci --omit=dev` leaves. */
function withoutDevDependencies() {
  const root = mkdtempSync(join(tmpdir(), "deps-prod-"));
  mkdirSync(join(root, "node_modules", "pg"), { recursive: true });
  return root;
}

/** A root that looks installed. */
function installed() {
  const root = mkdtempSync(join(tmpdir(), "deps-ok-"));
  mkdirSync(join(root, "node_modules", "tsx", "dist"), { recursive: true });
  writeFileSync(tsxPath(root), "");
  return root;
}

describe("dependenciesInstalled", () => {
  it("is true for this repository, which is installed", () => {
    expect(dependenciesInstalled(ROOT)).toBe(true);
  });

  it("is false for a fresh clone", () => {
    expect(dependenciesInstalled(freshClone())).toBe(false);
  });

  it("is false when node_modules exists but tsx does not", () => {
    // The `npm ci --omit=dev` shape. A guard that tested for node_modules would
    // pass here and let the unreadable error through, which is the case it is
    // for.
    const root = withoutDevDependencies();
    expect(dependenciesInstalled(root)).toBe(false);
  });
});

describe("installArgv", () => {
  it("runs npm's own entry point with this Node, never a shell", () => {
    const argv = installArgv({ npm_execpath: "/usr/lib/npm/bin/npm-cli.js" });
    expect(argv).toEqual({
      command: process.execPath,
      args: ["/usr/lib/npm/bin/npm-cli.js", "install"],
    });
  });

  it("produces a vector, so nothing in it can be interpreted as syntax", () => {
    // `npm.cmd` on Windows cannot be spawned without `shell: true`, and a shell
    // is what this avoids. Asserted as a property rather than a comment: every
    // element must be one literal argument.
    const argv = installArgv({ npm_execpath: "C:\\Program Files\\npm\\npm-cli.js" });
    for (const part of [argv.command, ...argv.args]) {
      expect(part).not.toMatch(/[&|;><`$]/);
    }
  });

  it("is null outside npm, so no binary is guessed at", () => {
    expect(installArgv({})).toBeNull();
  });
});

describe("main", () => {
  const capture = () => {
    const lines = [];
    return { lines, log: (line) => lines.push(String(line)) };
  };

  it("does nothing, and spawns nothing, when the tree is already installed", () => {
    const { lines, log } = capture();
    let spawned = 0;
    const code = main({
      root: installed(),
      env: { npm_execpath: "npm-cli.js" },
      log,
      spawn: () => {
        spawned += 1;
        return { status: 0 };
      },
    });
    expect(code).toBe(0);
    expect(spawned).toBe(0);
    expect(lines).toEqual([]);
  });

  it("installs, then reports success once tsx is actually there", () => {
    const root = freshClone();
    const { lines, log } = capture();
    const code = main({
      root,
      env: { npm_execpath: "npm-cli.js" },
      log,
      // Stands in for a real install: it creates what a real one would.
      spawn: () => {
        mkdirSync(join(root, "node_modules", "tsx", "dist"), { recursive: true });
        writeFileSync(tsxPath(root), "");
        return { status: 0 };
      },
    });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("Installing them now");
  });

  it("fails when npm exits 0 but tsx is still missing", () => {
    // The `--omit=dev` in someone's .npmrc case. Reporting success here would
    // hand back `'tsx' is not recognized` a second later, which is the error
    // this file exists to replace.
    const { lines, log } = capture();
    const code = main({
      root: freshClone(),
      env: { npm_execpath: "npm-cli.js" },
      log,
      spawn: () => ({ status: 0 }),
    });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("still missing");
    expect(lines.join("\n")).toContain("--omit=dev");
  });

  it("passes npm's own exit code through when the install fails", () => {
    const { lines, log } = capture();
    const code = main({
      root: freshClone(),
      env: { npm_execpath: "npm-cli.js" },
      log,
      spawn: () => ({ status: 254 }),
    });
    expect(code).toBe(254);
    expect(lines.join("\n")).toContain("did not finish");
  });

  it("reports a spawn that never ran at all", () => {
    const { lines, log } = capture();
    const code = main({
      root: freshClone(),
      env: { npm_execpath: "npm-cli.js" },
      log,
      spawn: () => ({ error: new Error("ENOENT"), status: null }),
    });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("npm install");
  });

  it("asks rather than guessing when it was not run by npm", () => {
    const { lines, log } = capture();
    let spawned = 0;
    const code = main({
      root: freshClone(),
      env: {},
      log,
      spawn: () => {
        spawned += 1;
        return { status: 0 };
      },
    });
    expect(code).toBe(1);
    expect(spawned).toBe(0);
    expect(lines.join("\n")).toContain("npm install");
  });
});

/**
 * Every root script runs a binary from `node_modules/.bin` - tsx, vitest,
 * prettier, tsc - so every one of them fails unreadably on a fresh clone. The
 * guard is therefore uniform rather than applied to the three the README
 * happens to name today, and this keeps it that way: a script added without it
 * is a script that reintroduces the bug for whoever runs it first.
 */
describe("root package.json", () => {
  it("guards every script", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const unguarded = Object.entries(pkg.scripts)
      .filter(([, command]) => !command.startsWith("node scripts/deps.mjs && "))
      .map(([name]) => name);
    expect(
      unguarded,
      "these scripts run before the dependency guard, so on a fresh clone they " +
        "fail with `'tsx' is not recognized` or the equivalent for their binary. " +
        "Prefix each with `node scripts/deps.mjs && `.",
    ).toEqual([]);
  });
});
