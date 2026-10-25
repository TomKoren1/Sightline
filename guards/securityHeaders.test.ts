/**
 * nginx sends the security headers, once, where they apply to everything.
 *
 * nginx drops a server block's add_header for any location that declares one
 * of its own, so a header added later "just for /api" would silently remove
 * every security header from API responses. Hence: none in a location.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const conf = readFileSync(fileURLToPath(new URL("../deploy/nginx.conf", import.meta.url)), "utf8");
const header = (name: string) =>
  new RegExp(String.raw`^\s*add_header ${name} "([^"]+)" always;`, "m").exec(conf)?.[1];

describe("nginx security headers", () => {
  it("sets each one, on every response", () => {
    for (const name of [
      "Content-Security-Policy",
      "Strict-Transport-Security",
      "X-Content-Type-Options",
      "X-Frame-Options",
      "Referrer-Policy",
      "Permissions-Policy",
    ]) {
      expect(header(name), name).toBeTruthy();
    }
    expect(conf).toMatch(/^\s*server_tokens off;/m);
  });

  it("allows no script from anywhere but the site, and no framing", () => {
    const csp = header("Content-Security-Policy")!;
    expect(csp).toMatch(/script-src 'self';/);
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);
    expect(csp).toMatch(/frame-ancestors 'none'/);
  });

  it("declares no add_header inside a location, which would drop them all there", () => {
    const locations = conf.split(/\n\s*location /).slice(1);
    expect(locations.filter((l) => l.split(/\n\s*}\n/)[0]!.includes("add_header"))).toEqual([]);
  });
});
