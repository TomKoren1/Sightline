/**
 * Every container image is pinned to a version and a digest.
 *
 * `motoserver/moto:latest` let a moto release change what the ground-truth
 * suite runs against without a commit; `neo4j:5-community` and the base images
 * floated the same way. Dependabot raises the bumps as reviewable PRs instead.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (p: string) => readFileSync(root + p, "utf8");

const manifests = ["deploy/k8s/base", "deploy/k8s/prod"].flatMap((dir) =>
  readdirSync(root + dir)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => `${dir}/${f}`),
);

/** Images this repository builds itself; kustomize sets their tags. */
const OWN = new Set(["sightline-api", "sightline-web"]);

function references(): { file: string; image: string }[] {
  const found: { file: string; image: string }[] = [];
  for (const file of ["docker-compose.yml", ...manifests]) {
    for (const m of read(file).matchAll(/^\s*-?\s*image:\s*["']?([^\s"'#]+)/gm)) {
      found.push({ file, image: m[1]! });
    }
  }
  for (const m of read("Dockerfile").matchAll(/^FROM\s+(\S+)/gm)) {
    found.push({ file: "Dockerfile", image: m[1]! });
  }
  return found;
}

const stages = new Set(
  [...read("Dockerfile").matchAll(/^FROM\s+\S+\s+AS\s+(\S+)/gim)].map((m) => m[1]!),
);

describe("image pins", () => {
  const external = references().filter(({ image }) => !OWN.has(image) && !stages.has(image));

  it("finds the images it is meant to guard", () => {
    // A parser that matched nothing would pass every assertion below.
    expect(external.length).toBeGreaterThanOrEqual(6);
  });

  it.each(external.map((r) => [r.image, r.file] as const))(
    "%s (%s) names a version and a digest",
    (image) => {
      expect(image, "pin a digest: name:version@sha256:…").toMatch(/:[^:@]+@sha256:[0-9a-f]{64}$/);
      expect(image, "a floating tag beside the digest misleads the reader").not.toMatch(
        /:(latest|alpine|\d+-alpine|\d+-community)@/,
      );
    },
  );
});
