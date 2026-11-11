/**
 * The lockfile must agree with `package.json` about the Node it needs.
 *
 * npm copies the root `engines` into `package-lock.json` and nothing in
 * editing the manifest updates the copy. The two drifted, and the symptom
 * lands on whoever clones next: `npm install` rewrites the stale half, so a
 * fresh clone is dirty before its owner has typed anything.
 *
 * Asserted here rather than left to a CI diff: it is a property of the two
 * files, and the fix is always `npm install --package-lock-only`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (path: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8"));

describe("the lockfile", () => {
  it("records the same engines as the root package", () => {
    const manifest = read("package.json") as { engines?: Record<string, string> };
    const lock = read("package-lock.json") as {
      packages: Record<string, { engines?: Record<string, string> }>;
    };

    // The empty key is the root package: every workspace keeps its own entry.
    const root = lock.packages[""];
    expect(root, "package-lock.json has no root package entry").toBeDefined();
    expect(root!.engines).toEqual(manifest.engines);
  });
});
