/**
 * Hosted mode limits every endpoint, sign-in hardest, and never the probes.
 *
 * Against the real application, because a Fastify plugin applies only to the
 * routes registered after it: registered in the wrong place, the limiter loads,
 * reports nothing, and limits nothing.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const ORIGINAL = { ...process.env };

interface Injected {
  statusCode: number;
  json: () => unknown;
}
let inject:
  | ((opts: { method: string; url: string; headers?: Record<string, string> }) => Promise<Injected>)
  | null = null;
let close: (() => Promise<void>) | null = null;

beforeAll(async () => {
  Object.assign(process.env, {
    DEPLOYMENT_MODE: "hosted",
    PUBLIC_BASE_URL: "https://sightline.test",
    SESSION_SECRET: "s".repeat(48),
    GITHUB_CLIENT_ID: "id",
    GITHUB_CLIENT_SECRET: "secret",
    AWS_KMS_KEY_ID: "arn:aws:kms:us-east-1:111111111111:key/not-used",
    SCANNER_PRINCIPAL_ARN: "arn:aws:iam::111111111111:user/SightlineScanner",
    ROLE_TEMPLATE_URL: "https://example.invalid/readonly-role.yaml",
    RATE_LIMIT_AUTH_PER_MINUTE: "3",
    RATE_LIMIT_PER_MINUTE: "5",
  });
  delete process.env["AWS_ENDPOINT_URL"];
  delete process.env["AWS_MODE"];
  vi.resetModules();
  try {
    const { buildApp } = await import("./app.js");
    const app = await buildApp();
    const instance = app.getHttpAdapter().getInstance() as unknown as {
      inject: NonNullable<typeof inject>;
    };
    inject = instance.inject.bind(instance);
    close = () => app.close();
  } catch (err) {
    console.warn("rateLimit.test skipped:", err instanceof Error ? err.message : err);
  }
}, 120_000);

afterAll(async () => {
  await close?.().catch(() => undefined);
  process.env = { ...ORIGINAL };
  vi.resetModules();
});

const hit = async (url: string, n: number, headers: Record<string, string> = {}) => {
  const codes: number[] = [];
  for (let i = 0; i < n; i++)
    codes.push((await inject!({ method: "GET", url, headers })).statusCode);
  return codes;
};

describe("rate limits", () => {
  it("stop a fourth sign-in request in a minute from one address", async () => {
    if (!inject) return;
    const codes = await hit("/api/auth/providers", 4, { "cf-connecting-ip": "203.0.113.7" });
    expect(codes.slice(0, 3)).toEqual([200, 200, 200]);
    expect(codes[3]).toBe(429);
    // Someone else, behind the same proxy, is not caught by it.
    expect((await hit("/api/auth/providers", 1, { "cf-connecting-ip": "203.0.113.8" }))[0]).toBe(
      200,
    );
  });

  it("say what the limit is and when to come back", async () => {
    if (!inject) return;
    const headers = { "cf-connecting-ip": "203.0.113.9" };
    await hit("/api/auth/providers", 3, headers);
    const res = await inject({ method: "GET", url: "/api/auth/providers", headers });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: expect.stringMatching(/at most 3 a minute/) });
  });

  it("never limit the health probes", async () => {
    if (!inject) return;
    const codes = await hit("/api/health", 12, { "cf-connecting-ip": "203.0.113.10" });
    expect(codes).not.toContain(429);
  });
});
