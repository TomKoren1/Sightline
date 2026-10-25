/**
 * The published API description: current, and complete.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { CONTRACTS, EXCLUDED, REQUEST_BODIES } from "./contract.js";
import { openApiDocument, openApiJson } from "./openapi.js";

const COMMITTED = fileURLToPath(new URL("../../../../docs/openapi.json", import.meta.url));

describe("the OpenAPI document", () => {
  it("is the one the contract list writes", () => {
    expect(
      readFileSync(COMMITTED, "utf8").replace(/\r\n/g, "\n") === openApiJson(),
      "docs/openapi.json is stale: run `npm run openapi -w @sightline/api` and commit it.",
    ).toBe(true);
  });

  it("lists every route, tested or not", () => {
    const paths = openApiDocument().paths;
    const listed = Object.entries(paths).flatMap(([path, ops]) =>
      Object.keys(ops).map((m) => `${m.toUpperCase()} ${path.replace(/\{(\w+)\}/g, ":$1")}`),
    );
    expect(listed.sort()).toEqual(
      [...CONTRACTS.map((c) => `${c.method} ${c.route}`), ...EXCLUDED.keys()].sort(),
    );
  });

  it("describes a request body only for a route that exists", () => {
    const routes = new Set([...CONTRACTS.map((c) => `${c.method} ${c.route}`), ...EXCLUDED.keys()]);
    expect([...REQUEST_BODIES.keys()].filter((k) => !routes.has(k))).toEqual([]);
  });
});
