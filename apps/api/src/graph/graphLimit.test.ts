/**
 * A bad `?limit` is refused, and a good one is honoured.
 *
 * `?limit=abc` answered **200 with an empty graph**: `Number("abc")` is `NaN`,
 * every clamp preserved it - `Math.max(1, NaN)` is `NaN` - and it reached the
 * database as `LIMIT 0`. Worse than a 500, because an empty result looks like an answer
 * and sends the reader to look for a problem in their AWS account.
 *
 * Both halves are asserted, since a guard that refused everything would also
 * pass the first. Requires Postgres: the assertion counts nodes, so
 * there have to be some.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { buildApp } from "../app.js";

const HAS_INFRA = !process.env["SKIP_INTEGRATION"];

let app: NestFastifyApplication | null = null;
let available = false;

beforeAll(async () => {
  if (!HAS_INFRA) return;
  process.env["LOG_LEVEL"] = "silent";
  try {
    app = await buildApp();
    await app.init();
    available = true;
  } catch {
    // No databases; the first test says so.
  }
});

afterAll(async () => {
  await app?.close();
});

async function graph(query: string) {
  const res = await app!.inject({ method: "GET", url: `/api/graph${query}` });
  return {
    status: res.statusCode,
    body: JSON.parse(res.body) as { nodes?: unknown[]; error?: string },
  };
}

describe.runIf(HAS_INFRA)("the graph endpoint's limit", () => {
  it("has a graph with something in it", async () => {
    // Without this every count below is trivially satisfiable, and the whole
    // file would pass against an empty database - which is precisely the state
    // the bug produced.
    expect(available, "the app could not be built, so nothing here was checked").toBe(true);
    if (!available) return;

    const { status, body } = await graph("");
    expect(status).toBe(200);
    expect(body.nodes?.length, "seed and scan the mock account first").toBeGreaterThan(10);
  });

  it("honours a limit it was given", async () => {
    if (!available) return;
    const { status, body } = await graph("?limit=7");
    expect(status).toBe(200);
    expect(body.nodes).toHaveLength(7);
  });

  it("refuses a limit that is not a whole number, and says so", async () => {
    if (!available) return;
    for (const bad of ["abc", "-5", "1e400", "7.5", "0x10", "٧"]) {
      const { status, body } = await graph(`?limit=${encodeURIComponent(bad)}`);
      expect(status, `limit=${bad}`).toBe(400);
      // Naming the value, because "invalid limit" leaves the caller guessing
      // which of their parameters was wrong.
      expect(body.error, `limit=${bad}`).toContain("whole number");
    }
  });

  it("treats an absent or empty limit as no limit asked for", async () => {
    if (!available) return;
    // `?limit=` is what a form sends for an untouched field, and refusing it
    // would break a client that is not doing anything wrong.
    for (const query of ["", "?limit="]) {
      const { status, body } = await graph(query);
      expect(status, query).toBe(200);
      expect(body.nodes?.length, query).toBeGreaterThan(10);
    }
  });

  it("never answers with an empty graph because of the limit", async () => {
    if (!available) return;
    /**
     * The property the bug violated, stated directly. Whatever a caller sends,
     * the endpoint either refuses it or returns nodes - it never says "your
     * account is empty" on account of a query parameter.
     */
    for (const value of ["0", "1", "abc", "", "-1", "999999999"]) {
      const { status, body } = await graph(`?limit=${encodeURIComponent(value)}`);
      if (status === 200) {
        expect(body.nodes?.length, `limit=${value} returned 200 with nothing`).toBeGreaterThan(0);
      } else {
        expect(status, `limit=${value}`).toBe(400);
      }
    }
  });
});
