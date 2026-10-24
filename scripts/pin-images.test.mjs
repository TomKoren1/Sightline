/** Pinning the prod overlay to one commit's images, as the deliver workflow does. */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { pin, pinnedCommit } from "./pin-images.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
/** @param {string} c */
const digest = (c) => `sha256:${c.repeat(64)}`;
const images = {
  web: `ghcr.io/tomkoren1/sightline-web@${digest("b")}`,
  api: `ghcr.io/tomkoren1/sightline-api@${digest("a")}`,
};

describe("pin-images", () => {
  it("appends a marked block naming the commit, and replaces it on the next run", () => {
    const once = pin("kind: Kustomization\n", "abc1234", images);
    expect(pinnedCommit(once)).toBe("abc1234");
    expect(once).toContain(
      `  - name: sightline-api\n    newName: ghcr.io/tomkoren1/sightline-api\n    digest: ${digest("a")}`,
    );
    const twice = pin(once, "def5678", {
      ...images,
      api: `ghcr.io/x/sightline-api@${digest("c")}`,
    });
    expect(pinnedCommit(twice)).toBe("def5678");
    expect(twice.match(/BEGIN pinned images/g)).toHaveLength(1);
    expect(twice).not.toContain(digest("a"));
  });

  it("refuses a reference that is not pinned by digest", () => {
    expect(() => pin("", "abc1234", { api: "ghcr.io/x/sightline-api:latest" })).toThrow(/sha256/);
  });

  it("leaves a rerun for the same commit alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "pin-"));
    const file = join(dir, "kustomization.yaml");
    writeFileSync(file, pin("kind: Kustomization\n", "abc1234", images));
    const out = execFileSync(
      process.execPath,
      [
        join(ROOT, "scripts/pin-images.mjs"),
        file,
        "abc1234",
        `api=${images.api}`,
        `web=${images.web}`,
      ],
      { encoding: "utf8" },
    );
    expect(out.trim()).toBe("unchanged");
  });

  it("renders: the prod overlay, pinned, points every app container at the digests", () => {
    if (spawnSync("kubectl", ["version", "--client"]).status !== 0) return;
    const dir = mkdtempSync(join(tmpdir(), "pin-render-"));
    cpSync(join(ROOT, "deploy/k8s"), join(dir, "k8s"), { recursive: true });
    const file = join(dir, "k8s/prod/kustomization.yaml");
    writeFileSync(file, pin(readFileSync(file, "utf8"), "abc1234", images));
    const rendered = execFileSync("kubectl", ["kustomize", join(dir, "k8s/prod")], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    const refs = [...rendered.matchAll(/image: (\S*sightline-(?:api|web)\S*)/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThanOrEqual(4);
    for (const ref of refs) expect(Object.values(images)).toContain(ref);
  });
});
