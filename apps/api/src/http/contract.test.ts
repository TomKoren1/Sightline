/**
 * HTTP contract tests: the shape of every response this API can produce.
 *
 * A safety net for the ORM and framework ports, not unit tests of the handlers.
 * Three decisions worth knowing before changing this file:
 *
 * - **Schemas were captured, not written.** Each endpoint was called against a
 *   populated database and its real response recorded. A contract invented from
 *   reading the handlers would pin what I *believed* it returned.
 * - **Top level is `.strict()`, nested shapes are not.** A dropped top-level
 *   field is the regression a port introduces; pinning every nested field would
 *   fail on changes nobody cares about, and then be deleted rather than fixed.
 * - **Every status an endpoint can return is declared, and any passes.** These
 *   legitimately vary with database state and `AWS_MODE`, so asserting one
 *   would make the suite a function of the machine it runs on.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildApp } from "./app.js";
import { CONTRACTS, EXCLUDED } from "./contract.js";

/**
 * Issuing a request runs the real handler against Postgres - a
 * contract test that stubbed them would not prove the route is reachable in the
 * product. Same gate, and the same reasoning, as `graph/resourceArn.test.ts`.
 */
const HAS_INFRA = !process.env["SKIP_INTEGRATION"];

let app: NestFastifyApplication;

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  if (app) await app.close();
});

describe.runIf(HAS_INFRA)("every endpoint returns a declared shape", () => {
  it.each(CONTRACTS.map((c) => [`${c.method} ${c.route}`, c] as const))("%s", async (_name, c) => {
    const res = await app.inject({
      method: c.method,
      url: c.url,
      ...(c.payload ? { payload: c.payload } : {}),
    });

    const declared = Object.keys(c.responses).map(Number);
    expect(
      declared,
      `${c.method} ${c.route} returned ${res.statusCode}, which is not a declared response. ` +
        `Body: ${res.body.slice(0, 300)}`,
    ).toContain(res.statusCode);

    const parsed = c.responses[res.statusCode]!.safeParse(res.json());
    expect(
      parsed.success ? null : JSON.stringify(parsed.error.issues, null, 2),
      `${c.method} ${c.route} responded ${res.statusCode} with a body that does not match its ` +
        "contract. If this is a deliberate API change, update the schema here and the frontend " +
        "that reads it; if it is a refactor, the refactor changed the payload.",
    ).toBeNull();
  });
});

/**
 * Every registered route has a contract, and every contract is a real route.
 *
 * Read from Fastify's own router rather than from the source, so a route added
 * through any path is in scope. Without this the suite would keep passing as
 * endpoints were added to it untested - which is the state this file was
 * written to end, and the failure mode of every "remember to add a test" rule.
 *
 * Both directions: an unlisted route is an untested payload, and a contract for
 * a route that no longer exists is a test asserting nothing while looking like
 * coverage.
 */
describe("the contract list is complete", () => {
  /** Fastify prints a tree; children carry their parent's prefix. */
  function registeredRoutes(tree: string): Set<string> {
    const found = new Set<string>();
    const stack: string[] = [];
    for (const line of tree.split("\n")) {
      const m = /^([\s│]*)(?:├──|└──)\s(\S+)\s\(([^)]+)\)\s*$/.exec(line);
      if (!m) continue;
      const depth = Math.floor(m[1]!.length / 4);
      stack.length = depth;
      stack[depth] = m[2]!;
      const path = stack.join("");
      for (const method of m[3]!.split(",").map((s) => s.trim())) {
        // HEAD is generated for every GET, and OPTIONS is the CORS plugin's
        // wildcard. Neither is a payload anyone depends on.
        if (method === "HEAD" || method === "OPTIONS") continue;
        found.add(`${method} ${path}`);
      }
    }
    return found;
  }

  it("parses the router, so the comparison below is comparing something", () => {
    // Without this, a change to Fastify's tree format would silently produce an
    // empty set and make both assertions below pass by finding nothing.
    const routes = registeredRoutes(
      app.getHttpAdapter().getInstance().printRoutes({ commonPrefix: false }),
    );
    expect(
      routes.size,
      "no routes parsed out of printRoutes — has the format changed?",
    ).toBeGreaterThan(10);
    expect(routes).toContain("GET /api/health");
    expect(routes).toContain("POST /api/chat");
  });

  it("covers every registered route, and lists none that do not exist", () => {
    const routes = registeredRoutes(
      app.getHttpAdapter().getInstance().printRoutes({ commonPrefix: false }),
    );
    const covered = new Set([
      ...CONTRACTS.map((c) => `${c.method} ${c.route}`),
      ...EXCLUDED.keys(),
    ]);

    const uncovered = [...routes].filter((r) => !covered.has(r)).sort();
    const stale = [...covered].filter((c) => !routes.has(c)).sort();

    expect(
      uncovered,
      "these routes have no contract, so a refactor could change their payload without " +
        "failing a test. Add an entry to CONTRACTS, or to EXCLUDED with a reason.",
    ).toEqual([]);
    expect(
      stale,
      "these contracts name routes that are no longer registered. Remove them — a " +
        "contract for a route that does not exist is coverage that asserts nothing.",
    ).toEqual([]);
  });

  it("gives a reason for every exclusion", () => {
    // An exclusion list is only honest while each entry says why. Without this,
    // the cheapest way to make the check above pass is to add a route to
    // EXCLUDED and move on, which converts the guard into a formality.
    const unexplained = [...EXCLUDED].filter(([, why]) => why.trim().length < 40).map(([r]) => r);
    expect(unexplained, "every excluded route needs a reason, not a placeholder").toEqual([]);
  });
});

/**
 * Every POST answers the status it answered before the framework arrived.
 *
 * Nest replies 201 to a POST unless told otherwise. Three endpoints here used
 * to answer 200, and moving them into controllers silently changed all three.
 * The contract above caught exactly one — `POST /api/connection/test`, the only
 * one whose success path it is safe to exercise. The other two are pinned on
 * their refusal path, so a changed success status sailed straight past.
 *
 * Reading the source closes that gap for the whole class rather than for the
 * two instances: a POST either declares its status, or hands the response to
 * Fastify through `@Res()` and sets it on the raw socket itself.
 */
describe("POST handlers declare their status code", () => {
  const SRC = fileURLToPath(new URL("./", import.meta.url));

  function controllerFiles(): string[] {
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".controller.ts")) found.push(path);
      }
    };
    walk(SRC);
    return found;
  }

  it("finds the controllers, so the check below has something to read", () => {
    expect(controllerFiles().length, "no *.controller.ts found").toBeGreaterThan(3);
  });

  it("gives every POST an explicit status or a raw reply", () => {
    const undeclared: string[] = [];
    for (const file of controllerFiles()) {
      const source = readFileSync(file, "utf8");
      // Each @Post and everything up to the end of its signature.
      for (const match of source.matchAll(/@Post\([^)]*\)([\s\S]*?)\)\s*\{/g)) {
        const block = match[0];
        if (block.includes("@HttpCode(") || block.includes("@Res(")) continue;
        undeclared.push(`${file.split("/src/")[1]}: ${block.split("\n")[0]}`);
      }
    }
    expect(
      undeclared,
      "these POST handlers will answer Nest's default 201. If that is what the " +
        "frontend expects, say so with @HttpCode(201); if it expects 200, add " +
        "@HttpCode(200). A raw @Res() handler sets its own status and is exempt.",
    ).toEqual([]);
  });
});
