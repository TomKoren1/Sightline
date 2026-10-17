/**
 * Every method on the frontend's API client is reachable from the product.
 *
 * Added after `api.disconnect` was found with no caller. The route, the purge
 * behind it and the tests over that purge all existed; the only way to reach
 * any of it was devtools. Nothing failed, because nothing was broken - a client
 * method with no caller is as green as one with ten.
 *
 * `UNUSED` is an explicit list with a reason each. Not a way to silence this:
 * it is the finding, written where the next person reads it, and the assertion
 * below turns red when one of them is finally wired up.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const webSrc = `${root}apps/web/src/`;
const client = readFileSync(`${webSrc}api.ts`, "utf8");

/**
 * Methods with no caller today, and why.
 *
 * Each is a route the API serves and the UI does not offer. They are real
 * gaps rather than dead code to delete - the sessions screen in particular is
 * a planned part of signing in - and they are listed here so that the next
 * orphan fails the build instead of joining them unnoticed.
 */
const UNUSED: Record<string, string> = {
  health:
    "`/api/health` is rendered by the Trust panel's own queries rather than through this method.",
  scans: "The banner shows the latest scan; there is no scan-history view yet.",
  sessions: "No 'your sessions' screen exists yet, though the routes behind it do.",
  revokeSession: "Same: per-session revocation has no control.",
  revokeAllSessions: "Same: 'sign out everywhere' has no control.",
  connections: "`me` already returns the tenant's connections, so nothing fetches them separately.",
};

/** Top-level keys of the `export const api = { … }` object literal. */
function clientMethods(): string[] {
  const start = client.indexOf("export const api = {");
  expect(start, "apps/web/src/api.ts no longer exports an `api` object").toBeGreaterThan(-1);

  const keys: string[] = [];
  let depth = 0;
  for (const line of client.slice(start).split("\n").slice(1)) {
    const trimmed = line.trim();
    if (depth === 0) {
      if (trimmed === "};") break;
      const key = /^([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(trimmed);
      if (key) keys.push(key[1]!);
    }
    // Nesting, so a key inside an inline object or argument list is not read
    // as a method of its own.
    for (const char of line) {
      if (char === "{" || char === "(") depth++;
      else if (char === "}" || char === ")") depth--;
    }
  }
  return keys;
}

/** Every source file in the web workspace except the client itself. */
function callers(dir = webSrc, into: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = `${dir}${entry}`;
    if (statSync(path).isDirectory()) callers(`${path}/`, into);
    else if (/\.tsx?$/.test(entry) && entry !== "api.ts") into.push(path);
  }
  return into;
}

describe("the frontend's API client", () => {
  const methods = clientMethods();
  const source = callers()
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");

  const used = (name: string) => source.includes(`api.${name}`);

  it("was parsed, along with the files that call it", () => {
    // Without this the whole file passes on an empty list, which is how a
    // guard over something it does not execute stops guarding.
    expect(methods.length).toBeGreaterThan(15);
    expect(methods).toContain("me");
    expect(source.length).toBeGreaterThan(10_000);
  });

  it("has a caller for every method, or an entry saying why not", () => {
    const orphans = methods.filter((name) => !used(name) && !(name in UNUSED));
    expect(
      orphans,
      "these API client methods are called from nowhere in `apps/web/src`, so the routes behind " +
        "them cannot be reached from the product. Add the control, or add the method to `UNUSED` " +
        "in this file with the reason.",
    ).toEqual([]);
  });

  it("has no stale entry in the list of methods with no caller", () => {
    const wired = Object.keys(UNUSED).filter(used);
    expect(
      wired,
      "these are listed in `UNUSED` and now have callers. Remove them from that list - it is " +
        "meant to describe the gaps that are still open.",
    ).toEqual([]);

    // And every entry still names a method that exists, so a renamed method
    // does not leave a note about something gone.
    const phantom = Object.keys(UNUSED).filter((name) => !methods.includes(name));
    expect(phantom, "these are in `UNUSED` but are no longer methods of the client").toEqual([]);
  });

  it("is the only thing in the app that calls the API", () => {
    /**
     * `ResourceDetail` and `Remediation` each used a bare `fetch`, which sends
     * none of the headers `withHeaders` adds - in particular
     * `X-Sightline-Connection`. The server fell back to the tenant's *oldest*
     * connection, so the detail panel answered about a different AWS account
     * than the one on screen.
     *
     * It presented as clicking a node showing nothing. Both endpoints were
     * correct, both components compiled, and both accounts belonged to one
     * tenant - so no isolation test could see it either.
     */
    const offenders = callers()
      .filter((file) => /\bfetch\(\s*[`"'][^`"')]*\/api/.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(root.length));

    expect(
      offenders,
      "these call the API without going through `api.ts`, so they send none of the headers it " +
        "adds - including the connection header, without which the server answers about the " +
        "tenant's oldest account rather than the selected one. Add a method to the client.",
    ).toEqual([]);
  });

  it("offers disconnecting an account, not just connecting one", () => {
    /**
     * Pinned by name rather than left to the general rule above.
     *
     * This is the one that was missing, and `PRIVACY.md` promises it: a
     * customer can remove an AWS account and everything held about it. If the
     * control is deleted in some future refactor, the generic check would be
     * satisfied by adding a line to `UNUSED`, and this would not.
     */
    expect(used("disconnect"), "the UI no longer offers a way to disconnect an account").toBe(true);
  });
});
