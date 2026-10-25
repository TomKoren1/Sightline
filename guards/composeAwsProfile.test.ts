/**
 * The documented way to give the container real AWS credentials must keep
 * working. Three artefacts must agree and nothing connected them: the
 * `COMPOSE_FILE` line in `.env.example`, the override file it names, and the
 * path inside the container the SDK reads.
 *
 * The first version told the reader to pass `-f` flags, which works - until the
 * README's own recreate command drops them and silently loses the mount. The
 * connection test then reported "No source credentials were found" for a setup
 * working a minute earlier. `COMPOSE_FILE` in `.env`
 * cannot fail that way, because Compose applies it to every invocation.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (p: string) => readFileSync(root + p, "utf8");

const envExample = read(".env.example");
const override = read("deploy/compose.aws-profile.yml");

/**
 * The home directory of the user the api image runs as.
 *
 * Derived from the Dockerfile rather than written down, because writing it down
 * is what failed: this file asserted the literal `/root/.aws` and kept passing
 * when the image gained `USER node`, so the host profile was mounted where the
 * SDK does not look and could not have read it anyway - `/root` is 0700.
 */
function containerHome(): string {
  const user = /^USER\s+(\S+)\s*$/m.exec(read("Dockerfile"));
  expect(user, "the Dockerfile no longer declares a USER for the api image").toBeTruthy();
  const name = user![1]!;
  return name === "root" ? "/root" : `/home/${name}`;
}

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
     * Target and mode, not the whole literal spec - the source side carries
     * fallbacks and is covered separately. `ro` matters: a scanner arguing for
     * least privilege has no business writing the credentials it was lent.
     */
    const home = containerHome();
    expect(
      override,
      `the mount must land in ${home}/.aws, which is where the user the image ` +
        "runs as resolves ~ to",
    ).toContain(`:${home}/.aws:ro`);
  });

  it("agrees with the path the API actually reads", () => {
    // The other half: aws/settings.ts resolves the profile directory from HOME
    // and falls back to this constant. If the two drift, the mount lands
    // somewhere nothing reads - which is exactly what shipped.
    const config = read("apps/api/src/aws/settings.ts");
    const declared = /export const CONTAINER_HOME = "([^"]+)"/.exec(config);
    expect(declared, "aws/settings.ts no longer declares CONTAINER_HOME").toBeTruthy();
    expect(declared![1]).toBe(containerHome());
  });

  it("would notice the mount target drifting from the container user", () => {
    // A canary: if `containerHome()` silently returned something constant, the
    // two assertions above would pass for any Dockerfile at all.
    expect(containerHome()).toBe("/home/node");
    expect(containerHome()).not.toBe("/root");
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
     * was a warning.
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
