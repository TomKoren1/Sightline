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
const guide = readFileSync(`${root}apps/web/src/components/ConnectionGuide.tsx`, "utf8");

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
     * On a host the credential chain finds ~/.aws by itself, so this callout
     * would be noise - and noise in a security flow is how the parts that matter
     * stop being read. It must sit inside the containerised branch.
     */
    const at = guide.indexOf("COMPOSE_FILE=docker-compose.yml");
    expect(at, "the mount instruction is gone").toBeGreaterThan(-1);
    const guard = guide.lastIndexOf("{c.containerised && (", at);
    expect(guard, "the mount instruction is not inside a containerised-only block").toBeGreaterThan(
      -1,
    );
  });

  it("warns Windows readers about HOME, where the mount fails silently", () => {
    expect(guide).toContain("AWS_PROFILE_DIR");
    expect(guide).toMatch(/PowerShell/);
  });
});
