/**
 * The documented way to give the container real AWS credentials must keep working.
 *
 * Three artefacts have to agree and nothing connected them: the `COMPOSE_FILE`
 * line commented into `.env.example`, the override file it names, and the path
 * inside the container that the AWS SDK actually reads.
 *
 * This exists because the first version of that documentation was wrong in a way
 * that only appeared on the second command. It told the reader to pass `-f` flags,
 * which works — and then the README's own instruction for picking up an edited
 * `.env` (`docker compose --profile app up -d api`) recreated the container
 * *without* them, silently dropping the mount. The connection test then reported
 * "No source credentials were found" for a setup that had been working a minute
 * earlier (engineering log #45).
 *
 * `COMPOSE_FILE` in `.env` cannot fail that way, because Compose applies it to
 * every invocation. These assertions pin that it stays correct.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (p: string) => readFileSync(root + p, "utf8");

const envExample = read(".env.example");
const override = read("deploy/compose.aws-profile.yml");

/** The COMPOSE_FILE value as documented, commented out. */
function documentedComposeFiles(): string[] {
  const m = /^#\s*COMPOSE_FILE=(.+)$/m.exec(envExample);
  expect(m, "the COMPOSE_FILE line is no longer documented in .env.example").toBeTruthy();
  return m![1]!.trim().split(":");
}

describe("the real-AWS override for the containerised app", () => {
  it("documents COMPOSE_FILE rather than -f flags", () => {
    // The whole point: flags have to be repeated on every command, and the one
    // command the README tells you to run next is the one that loses them.
    const files = documentedComposeFiles();
    expect(files.length, "COMPOSE_FILE must list the base file and the override").toBe(2);
    expect(files[0]).toBe("docker-compose.yml");
  });

  it("names files that exist", () => {
    for (const file of documentedComposeFiles()) {
      expect(existsSync(root + file), `COMPOSE_FILE names ${file}, which does not exist`).toBe(
        true,
      );
    }
  });

  it("stays commented out, so the default path is unaffected", () => {
    // Uncommented, every `docker compose` command would try to mount ${HOME}/.aws
    // - including the mock path, for someone who never touches real AWS, on a
    // platform where HOME may not be set at all.
    expect(/^COMPOSE_FILE=/m.test(envExample), "COMPOSE_FILE must be commented out").toBe(false);
  });

  it("mounts the host profile read-only, at the path the SDK reads", () => {
    /**
     * Asserted as target + mode rather than as the whole literal spec, which is
     * what this checked first and why it broke when the source side gained an
     * override variable. The invariant is "whatever the source, it lands at
     * /root/.aws and cannot be written" - the source path is covered separately.
     *
     * `ro` matters: a scanner arguing for least privilege has no business being
     * able to write the credentials it was lent.
     */
    expect(override).toMatch(/:\/root\/\.aws:ro/);
  });

  it("only touches the api service", () => {
    // If this ever grew a second service, the seeder is the dangerous one: it
    // writes to whatever account its credentials resolve to.
    const services = [...override.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((m) => m[1]);
    expect(services).toEqual(["api"]);
  });

  it("resolves a path on a shell with no HOME, which Windows PowerShell is", () => {
    /**
     * The fallback alone is not portable, and it fails *quietly*: Compose treats
     * an unset variable as an empty string with a warning, so `${HOME}/.aws`
     * becomes `/.aws`, mounts nothing, and produces the same missing-credentials
     * error the mount exists to prevent. Verified by running `docker compose
     * config` with HOME stripped: source became `/.aws` and the only complaint
     * was a warning (engineering log #45).
     *
     * USERPROFILE is the fallback rather than a Windows path in .env, because
     * .env is shared by every shell: a `C:/...` value there is rejected as an
     * "invalid volume specification" when the same checkout runs Compose from
     * WSL, whose Linux CLI does not translate drive letters.
     */
    expect(override, "the mount must fall back to USERPROFILE where HOME is unset").toMatch(
      /\$\{AWS_PROFILE_DIR:-\$\{HOME:-\$\{USERPROFILE\}\}\/\.aws\}/,
    );
    expect(envExample, "AWS_PROFILE_DIR must be documented for shells without HOME").toMatch(
      /^#\s*AWS_PROFILE_DIR=/m,
    );
    // Commented out, like COMPOSE_FILE: on a shell that does set HOME, an
    // explicit path is one more thing to get wrong.
    expect(/^AWS_PROFILE_DIR=/m.test(envExample)).toBe(false);
  });

  it("is referenced by the documentation that tells people to use it", () => {
    const readme = read("README.md");
    expect(readme).toContain("COMPOSE_FILE=docker-compose.yml:deploy/compose.aws-profile.yml");
    /**
     * And the trap it avoids is stated, not only the command. Newlines are
     * collapsed first: the README is prose wrapped by Prettier, so a phrase can
     * land across a line break at any time, and a regex that assumes otherwise
     * fails on a reflow rather than on a real regression.
     */
    const flowed = readme.replace(/\s+/g, " ");
    expect(flowed, "the README should say the setting applies to every compose command").toMatch(
      /applies to \*\*every\*\* subsequent `docker compose` command/,
    );
    expect(flowed, "the README should say what goes wrong with -f flags").toMatch(
      /drops the mount without saying so/,
    );
    // Windows is the platform this was never tested on, so the guidance for it
    // must not quietly disappear. COMPOSE_FILE is split on `;` there, so the
    // `:` form fails unless the separator is set alongside it.
    expect(readme).toContain("COMPOSE_PATH_SEPARATOR=:");
    expect(envExample).toMatch(/^#\s*COMPOSE_PATH_SEPARATOR=:/m);
    expect(flowed, "the README should say what Windows needs").toMatch(
      /On Windows there is nothing more to set/,
    );
  });
});
