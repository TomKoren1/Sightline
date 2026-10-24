/**
 * Every compiled file a deployment runs is one the API build produces.
 *
 * The image runs `node apps/api/dist/<name>.js`, named in the Dockerfile, the
 * compose file, the manifests and the operator docs, while the names come from
 * `ENTRY_POINTS` in `apps/api/build.mjs`. Rename or drop one there and a
 * migration job fails with "Cannot find module" on the next deploy - not in any
 * test, since tests run the TypeScript.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (p: string) => readFileSync(root + p, "utf8");

const buildScript = read("apps/api/build.mjs");
const entryBlock = /const ENTRY_POINTS = \{([^}]*)\}/.exec(buildScript)?.[1] ?? "";
const ENTRY_POINTS = new Set([...entryBlock.matchAll(/^\s*"?([\w-]+)"?\s*:/gm)].map((m) => m[1]!));

const CONSUMERS = [
  "Dockerfile",
  "docker-compose.yml",
  "deploy/k8s/base/app.yaml",
  "deploy/k8s/README.md",
];

describe("the API's compiled entry points", () => {
  it("are read from the build script", () => {
    expect([...ENTRY_POINTS]).toEqual(expect.arrayContaining(["server", "worker", "migrate"]));
  });

  it.each(CONSUMERS)("%s runs only files the build produces", (file) => {
    const named = [...read(file).matchAll(/apps\/api\/dist\/([\w-]+)\.js/g)].map((m) => m[1]!);
    for (const name of named) expect(ENTRY_POINTS, `${file} runs dist/${name}.js`).toContain(name);
  });

  it("are what the deployment runs, not npm", () => {
    expect(read("deploy/k8s/base/app.yaml")).not.toMatch(/"npm"/);
  });
});
