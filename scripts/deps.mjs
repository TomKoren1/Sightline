#!/usr/bin/env node
/**
 * Install the project's dependencies if an npm script needs them and they are
 * missing. Every root script is prefixed `node scripts/deps.mjs &&`.
 *
 * On a fresh clone the README's own `npm run setup` fails with
 * `'tsx' is not recognized as an internal or external command` - true, not the
 * reader's fault, and no help at all.
 *
 * This works as a prefix rather than a wrapper because npm puts
 * `node_modules/.bin` on PATH whether or not it exists, and PATH resolves at
 * execution - so installing here lets the second half of the `&&` find its
 * binary on the same run, leaving every existing command byte-identical.
 *
 * Zero dependencies and plain JavaScript: it is the one file that must run when
 * nothing is installed, so it cannot import the workspace packages - they are
 * TypeScript and need the very binary whose absence it handles.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The repository root as a filesystem path.
 *
 * `fileURLToPath`, not `URL.pathname`: on Windows the latter yields
 * `/C:/projects/app/`, and any directory containing a space arrives
 * percent-encoded. Both are unopenable. Same conversion, and the same reason, as
 * `ENV_FILE` in `apps/api/src/config.ts` (engineering log #36).
 */
export const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** Where `tsx` lands once the tree is installed. */
export function tsxPath(root = ROOT) {
  return join(root, "node_modules", "tsx", "dist", "cli.mjs");
}

/**
 * Probe `tsx` rather than `node_modules`.
 *
 * A directory left by `npm ci --omit=dev` satisfies "node_modules exists" while
 * containing none of the tooling every script here runs through, so that test
 * would pass in precisely the case this guard is for.
 */
export function dependenciesInstalled(root = ROOT) {
  return existsSync(tsxPath(root));
}

/**
 * How to run `npm install` without a shell.
 *
 * On Windows `npm` is `npm.cmd`, and since Node 20.12 `spawn` refuses to launch
 * a `.cmd` unless `shell: true` - which would hand a command line back to a
 * shell parser for the sake of running one constant command. npm sets
 * `npm_execpath` to its own JavaScript entry point whenever it runs a script, so
 * the same Node process we are already inside can run it directly: one argv
 * vector, no shell, identical on every platform.
 *
 * Returns null when the variable is absent - someone running this file by hand,
 * outside npm - in which case we ask rather than guess at a binary.
 */
export function installArgv(env = process.env) {
  const cli = env["npm_execpath"];
  if (!cli) return null;
  return { command: process.execPath, args: [cli, "install"] };
}

/** @param {string} why - the sentence explaining what went wrong, shown first. */
const MANUAL = (why) =>
  `${why}\n\n  npm install\n\n` +
  "Then run the same command again. It writes only to node_modules/ in this folder.";

export const NOTICE =
  "The project's dependencies are not installed yet, so this command cannot run.\n" +
  "Installing them now: this happens once, takes a minute or two, and writes only\n" +
  "to node_modules/ in this folder.\n";

/**
 * The slice of `spawnSync` this file depends on. Declared rather than inherited
 * from `typeof spawnSync` so a test can pass a two-field stub instead of a
 * whole `SpawnSyncReturns` - which, in plain JavaScript, it cannot build.
 *
 * @typedef {(
 *   command: string,
 *   args: string[],
 *   options: { cwd: string; stdio: "inherit" },
 * ) => { status: number | null; error?: Error }} Spawn
 */

/**
 * @param {{
 *   root?: string,
 *   env?: Record<string, string | undefined>,
 *   log?: (message: string) => void,
 *   spawn?: Spawn,
 * }} [options]
 * @returns the process exit code. 0 means the dependencies are present.
 */
export function main({
  root = ROOT,
  env = process.env,
  log = console.error,
  spawn = spawnSync,
} = {}) {
  if (dependenciesInstalled(root)) return 0;

  const npm = installArgv(env);
  if (!npm) {
    log(MANUAL("The project's dependencies are not installed yet."));
    return 1;
  }

  log(NOTICE);
  const result = spawn(npm.command, npm.args, { cwd: root, stdio: "inherit" });

  if (result.error || result.status !== 0) {
    log(
      MANUAL(
        "npm install did not finish, so the dependencies are still missing.\n" +
          "Whatever it reported above is the thing to fix - usually no network\n" +
          "connection, or a Node older than 20.",
      ),
    );
    return typeof result.status === "number" && result.status !== 0 ? result.status : 1;
  }

  /**
   * Check again rather than trusting the exit code.
   *
   * `npm install` can succeed against a tree that still lacks what we need -
   * an `--omit=dev` configured in `.npmrc` being the obvious way. Reporting
   * success here would hand the reader back the original unreadable error, which
   * is the whole failure this file exists to prevent.
   */
  if (!dependenciesInstalled(root)) {
    log(
      MANUAL(
        `npm install finished, but ${tsxPath(root)} is still missing.\n` +
          "Something is excluding devDependencies - check for --omit=dev or\n" +
          "NODE_ENV=production in your npm config.",
      ),
    );
    return 1;
  }

  return 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exit(main());
}
