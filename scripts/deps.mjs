#!/usr/bin/env node
/**
 * Make sure the project's dependencies are installed, before an npm script that
 * needs them tries to run.
 *
 * Every script in the root `package.json` is prefixed with `node
 * scripts/deps.mjs &&`, so this runs first and the real command runs second.
 *
 * **Why this exists.** The README promises Docker and nothing else, and then
 * tells the reader to run `npm run setup -- --anthropic-key sk-ant-...`. On a
 * fresh clone that has never been `npm install`ed there is no `tsx`, so the
 * shell reports:
 *
 *     'tsx' is not recognized as an internal or external command
 *
 * which is true, is not the reader's fault, and does not name the thing they
 * need to do. It is also not specific to `setup`: `npm run drift` and `npm run
 * scan` are in the same README paragraph and fail the same way, as would every
 * other script here, since all of them are binaries under `node_modules/.bin`.
 *
 * `npm` puts `node_modules/.bin` on PATH whether or not that directory exists,
 * and PATH is resolved when the command is executed rather than when the script
 * starts - so installing here makes the second half of the `&&` find its binary
 * on the same run. That is what lets this be a prefix rather than a wrapper, and
 * it is why the existing commands are left byte-for-byte identical after it: no
 * working path changes shape to gain this.
 *
 * Zero dependencies and plain JavaScript on purpose. It is the one file that has
 * to run correctly when nothing is installed, so it may not import from the
 * workspace packages, which are TypeScript and need `tsx` to load - the very
 * thing whose absence it exists to handle.
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
 * The narrow slice of `spawnSync` this file actually depends on.
 *
 * Declared rather than inherited from `typeof spawnSync` so the seam states its
 * own contract: the only things read from the result are the exit status and the
 * spawn error. A test can then pass a two-field stub instead of constructing a
 * whole `SpawnSyncReturns` - which, in plain JavaScript, it cannot do at all.
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
