/**
 * No control characters in source. A backspace byte inside a regex literal
 * looks like `\b` in most editors and matches nothing, which is how one
 * reached a test helper and made it compare raw IP addresses.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const TEXT = /\.(ts|tsx|mjs|js|sh|md|ya?ml|json|css|html|sql)$/;
// Tab, newline and carriage return are the only control characters text needs.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

describe("source text", () => {
  it("holds no control characters", () => {
    const files = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter((f) => TEXT.test(f));
    expect(files.length).toBeGreaterThan(100);
    const bad = files.filter((f) => CONTROL.test(readFileSync(`${root}${f}`, "utf8")));
    expect(bad).toEqual([]);
  });
});
