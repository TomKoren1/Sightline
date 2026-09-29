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

  it("shows the credentials mount only in a container", () => {
    /**
     * Asserted by call site, not by scanning backwards for the nearest guard -
     * which is how this passed while the guard had been removed: an unrelated
     * `{c.containerised && (` earlier in the file satisfied the search. The
     * content now lives in a named component with exactly one call site, and
     * that call site has to be guarded.
     *
     * On a host the credential chain finds ~/.aws by itself, so showing it there
     * is noise, and noise in a security flow is how the parts that matter stop
     * being read.
     */
    expect(guide, "the mount instruction is gone").toContain("COMPOSE_FILE=docker-compose.yml");

    const definition = guide.indexOf("function ContainerCredentialsNote()");
    expect(definition, "ContainerCredentialsNote was renamed or inlined").toBeGreaterThan(-1);
    const body = guide.slice(definition, guide.indexOf("\n}", definition));
    expect(body, "the mount instruction moved out of the container-only component").toContain(
      "COMPOSE_FILE=docker-compose.yml",
    );

    const callSites = [...guide.matchAll(/<ContainerCredentialsNote\s*\/>/g)];
    expect(callSites, "expected exactly one call site").toHaveLength(1);
    const before = guide.slice(Math.max(0, callSites[0]!.index! - 60), callSites[0]!.index!);
    expect(before, "the call site is not guarded by c.containerised").toContain(
      "c.containerised &&",
    );
  });

  it("warns Windows readers about HOME, where the mount fails silently", () => {
    expect(guide).toContain("AWS_PROFILE_DIR");
    expect(guide).toMatch(/PowerShell/);
  });
});
