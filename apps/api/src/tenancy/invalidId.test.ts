/**
 * No route answers 500 to a mistyped id.
 *
 * Behavioural, and over the **real** route table rather than a list of the
 * routes somebody remembered take an id - because the bug this guards was
 * exactly a forgotten one. Five routes returned 500 for a malformed uuid, and
 * one of them, `connections/:id/onboarding`, had already had the same problem
 * fixed on a different code path into the same handler: the header was
 * validated and the path parameter was not. A per-route fix is opt-in, and the
 * next route to take an id would have had the bug again with nothing failing.
 *
 * The invariant is deliberately phrased as "not 500" rather than "exactly 400",
 * because it has to hold for every parameter and not only for uuids. A route
 * taking an ARN should answer 400 or 404 for junk - what it must never do is
 * claim the service is broken when the request was.
 *
 * 500 is the one wrong answer here. It tells an operator to go and look at the
 * server, and it tells a client to retry; both are wrong when the request can
 * never succeed as sent.
 *
 * Requires Postgres and Neo4j: a route that cannot reach its database answers
 * 500 for a reason that has nothing to do with the id, which would make this
 * pass or fail for the wrong reason.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import type { RouteInfo } from "../app.js";

const HAS_INFRA = !process.env["SKIP_INTEGRATION"];

/**
 * Junk that is a legal path segment and no kind of id.
 *
 * Not a uuid, not a number, and not percent-encoded - so it reaches the handler
 * intact and is rejected on its merits rather than by the router.
 */
const JUNK = "not-a-real-id";

interface Injected {
  statusCode: number;
  body: string;
}

const routes: RouteInfo[] = [];
let inject:
  | ((opts: { method: string; url: string; headers?: Record<string, string> }) => Promise<Injected>)
  | null = null;
let close: (() => Promise<void>) | null = null;
let available = false;

beforeAll(async () => {
  if (!HAS_INFRA) return;
  // This test deliberately makes dozens of failing requests; at the default
  // level Fastify logs every one and buries the result.
  process.env["LOG_LEVEL"] = "silent";
  try {
    const app = await buildApp({ onRoute: (route) => routes.push(route) });
    const instance = app.getHttpAdapter().getInstance();
    inject = (opts) =>
      // Fastify's `inject` wants its own HTTPMethods union; the route table
      // carries the method as a plain string.
      instance.inject({ ...opts, method: opts.method as "GET" });
    close = () => app.close();
    available = true;
  } catch {
    // No databases, or a configuration this cannot build; the first test says so.
  }
});

afterAll(async () => {
  await close?.();
});

/** Routes with at least one `:param`, deduplicated by method and url. */
function parameterised(): RouteInfo[] {
  const seen = new Set<string>();
  return routes.filter((route) => {
    if (!route.url.includes("/:")) return false;
    // Fastify registers HEAD alongside GET; one of them is enough.
    if (route.method === "HEAD") return false;
    const key = `${route.method} ${route.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

describe.runIf(HAS_INFRA)("a malformed id", () => {
  it("found the real route table, with parameterised routes in it", () => {
    // Without this the file passes vacuously the moment `buildApp` changes
    // shape or the databases are absent - which is how a guard stops guarding.
    expect(available, "the app could not be built, so nothing below was checked").toBe(true);
    expect(parameterised().length).toBeGreaterThan(3);
  });

  it("never makes a route claim the server is broken", async () => {
    if (!available || !inject) return;

    const blamedTheServer: string[] = [];

    for (const route of parameterised()) {
      const url = route.url.replace(/:[^/]+/g, JUNK);
      const res = await inject({
        method: route.method,
        url,
        // Self-hosted needs no session; the header is what the guard wants on a
        // mutating request, and sending it always keeps this test about ids.
        headers: { "x-sightline-request": "1" },
      });

      if (res.statusCode >= 500) {
        blamedTheServer.push(`${route.method} ${route.url} -> ${res.statusCode}`);
      }
    }

    expect(
      blamedTheServer,
      "these routes answered 5xx to a path parameter that was never a valid id. A request that " +
        "cannot succeed as sent is the client's error, not the server's: validate the parameter " +
        "with the `as*Id` helpers, which `InvalidIdFilter` turns into a 400 for every route at " +
        "once.",
    ).toEqual([]);
  });

  it("says which id it was, and says it as a 400", async () => {
    if (!available || !inject) return;

    // The two from the phase that introduced them, pinned by name so the
    // message a user sees is also covered rather than only the status.
    const cases = [
      { url: `/api/scans/${JUNK}`, expected: "Invalid scan id" },
      { url: `/api/scans/jobs/${JUNK}`, expected: "Invalid scan job id" },
      { url: `/api/connections/${JUNK}/onboarding`, expected: "Invalid connection id" },
    ];

    for (const { url, expected } of cases) {
      const res = await inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(400);
      expect(JSON.parse(res.body).error, url).toBe(expected);
    }
  });

  it("still answers 404 for an id that is well formed and simply absent", async () => {
    if (!available || !inject) return;

    /**
     * The other half of the distinction, and the reason this is not just "any
     * 4xx will do": a syntactically valid id that nobody owns must be
     * indistinguishable from one that was never created, and that is a 404 -
     * not a 400, which would tell the caller the id itself was wrong.
     */
    const absent = "11111111-1111-1111-1111-111111111111";
    for (const url of [`/api/scans/${absent}`, `/api/scans/jobs/${absent}/stream`]) {
      const res = await inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(404);
    }
  });
});
