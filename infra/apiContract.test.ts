/**
 * The web client declares no response shapes of its own.
 *
 * Every response the API sends is defined once, as a schema in
 * packages/shared/src/api.ts, which the API's contract test validates real
 * responses against. An interface written in the client instead is a fourth
 * copy that nothing compares - how `roleArn` came to be typed string in one
 * place and nullable in another.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (p: string) =>
  readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), "utf8");

describe("the API contract", () => {
  it("is where the web client's response types come from", () => {
    const client = read("apps/web/src/api.ts");
    expect(client).toMatch(/from "@sightline\/shared\/api"/);
    const declared = [...client.matchAll(/^export (?:interface|type) (\w+)\s*[={]/gm)].map(
      (m) => m[1],
    );
    expect(declared, "define it in packages/shared/src/api.ts").toEqual([]);
  });

  it("is imported by the browser as types only, so no schema joins its bundle", () => {
    const runtime = [
      ...read("apps/web/src/api.ts").matchAll(/^import (?!type)[^\n]*"@sightline\/shared\/api"/gm),
    ];
    expect(runtime).toEqual([]);
  });
});
