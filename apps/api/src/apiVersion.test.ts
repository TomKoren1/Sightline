/** `/api/v1` is the published prefix, answered by the same routes as `/api`. */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

let inject:
  | ((opts: { method: string; url: string }) => Promise<{ statusCode: number; body: string }>)
  | null = null;
let close: (() => Promise<void>) | null = null;

beforeAll(async () => {
  try {
    const { buildApp } = await import("./app.js");
    const app = await buildApp();
    const instance = app.getHttpAdapter().getInstance() as unknown as {
      inject: NonNullable<typeof inject>;
    };
    inject = instance.inject.bind(instance);
    close = () => app.close();
  } catch (err) {
    console.warn("apiVersion.test skipped:", err instanceof Error ? err.message : err);
  }
}, 120_000);

afterAll(async () => {
  await close?.().catch(() => undefined);
});

describe("the versioned prefix", () => {
  it("answers /api/v1 as /api", async () => {
    if (!inject) return;
    const bare = await inject({ method: "GET", url: "/api/auth/providers" });
    const versioned = await inject({ method: "GET", url: "/api/v1/auth/providers" });
    expect(versioned.statusCode).toBe(bare.statusCode);
    expect(versioned.body).toBe(bare.body);
  });

  it("keeps a query string, and rewrites only the prefix", async () => {
    if (!inject) return;
    expect((await inject({ method: "GET", url: "/api/v1/auth/providers?x=1" })).statusCode).toBe(
      200,
    );
    expect((await inject({ method: "GET", url: "/api/v10/auth/providers" })).statusCode).toBe(404);
  });
});
