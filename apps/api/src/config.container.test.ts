/**
 * The onboarding guide shows one restart command, chosen by where the API runs.
 *
 * Both instructions exist and only one is right for any given reader, and the
 * wrong one wastes real time: `docker compose restart api` exits zero and ignores
 * an edited `.env` entirely, because it reuses the environment resolved when the
 * container was created (engineering log #44). Showing both and a rule for
 * choosing is how a reader picks wrong.
 *
 * So the server reports which case it is in, and the guide renders accordingly.
 * These assertions pin that the detection and both branches survive.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { inContainer } from "./config.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const source = readFileSync(`${root}apps/web/src/components/ConnectionGuide.tsx`, "utf8");

/**
 * The guide with comments removed, because a comment cannot be rendered.
 *
 * Assertions here are about what the page shows, and matching a comment instead
 * of the copy is how one of them passed while the thing it guarded was gone.
 */
const guide = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("container detection", () => {
  it("agrees with the marker the Docker daemon writes", () => {
    // Not asserting a fixed value: this suite runs on a laptop and in CI's
    // containerised job, and it must be correct in both.
    expect(inContainer()).toBe(existsSync("/.dockerenv"));
  });
});

describe("the guide renders one restart instruction, matched to the runtime", () => {
  it("reads the flag the server reports", () => {
    expect(guide, "the guide no longer branches on c.containerised").toContain("c.containerised");
  });

  it("gives the recreate command for a container, and warns off restart", () => {
    expect(guide).toContain("docker compose --profile app up -d api");
    // The trap is the whole reason this branch exists.
    expect(guide).toMatch(/docker compose restart api/);
  });

  it("gives the host command too, so neither reader is left out", () => {
    expect(guide).toContain("npm run dev:api");
  });

  it("puts the credentials mount in the .env snippet, only in a container", () => {
    /**
     * Both lines, in the snippet the reader already pastes in step 3. As a
     * separate note under step 4 it was read after the restart it had to
     * precede, and it carried COMPOSE_FILE without the separator line Windows
     * Compose needs to split it.
     *
     * On a host the credential chain finds ~/.aws by itself, so the lines are
     * spread in only behind `c.containerised`.
     */
    const mount = /const CONTAINER_PROFILE_MOUNT = \[([\s\S]*?)\];/.exec(guide);
    expect(mount, "CONTAINER_PROFILE_MOUNT was renamed or removed").toBeTruthy();
    expect(mount![1]).toContain("COMPOSE_PATH_SEPARATOR=:");
    expect(mount![1]).toContain("COMPOSE_FILE=docker-compose.yml:deploy/compose.aws-profile.yml");

    const snippet = /const envSnippet = \[([\s\S]*?)\]\.join/.exec(guide);
    expect(snippet, "envSnippet was renamed or restructured").toBeTruthy();
    expect(snippet![1], "the mount is not in the .env snippet, or is not container-only").toContain(
      "c.containerised ? CONTAINER_PROFILE_MOUNT : []",
    );
  });
});
