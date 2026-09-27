/**
 * Session cookies.
 *
 * A signed cookie is the whole authentication story after sign-in, so the
 * tests here are about forgery rather than about round-tripping: every way a
 * cookie can be wrong must produce "not signed in", and none of them may
 * produce a *different* answer from the others, because a distinguishable
 * failure tells an attacker which part of their forgery to fix.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL = { ...process.env };

beforeEach(() => {
  process.env["SESSION_SECRET"] = "test-session-secret-not-a-real-one";
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.resetModules();
});

const load = () => import("./session.js");

const USER = "9f1d8c2e-0000-4000-8000-000000000001";
const TENANT = "3a2b1c0d-0000-4000-8000-000000000002";

describe("a session cookie", () => {
  it("round trips the user and tenant", async () => {
    const { newSession, decodeSession } = await load();
    const session = decodeSession(newSession(USER, TENANT as never));
    expect(session?.userId).toBe(USER);
    expect(session?.tenantId).toBe(TENANT);
  });

  it("carries nothing but identifiers", async () => {
    const { newSession } = await load();
    const body = newSession(USER, TENANT as never).split(".")[0]!;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as object;
    // No tokens, no email, no API key - the cookie is readable by whoever
    // holds it, so what it may contain is exactly two identifiers and a clock.
    expect(Object.keys(payload).sort()).toEqual(["exp", "iat", "tid", "uid"]);
  });
});

describe("cookies that must not be accepted", () => {
  it("rejects nothing at all", async () => {
    const { decodeSession } = await load();
    expect(decodeSession(undefined)).toBeNull();
    expect(decodeSession("")).toBeNull();
  });

  it("rejects a cookie with no signature", async () => {
    const { decodeSession } = await load();
    const body = Buffer.from(
      JSON.stringify({ uid: USER, tid: TENANT, exp: Date.now() + 1000 }),
    ).toString("base64url");
    expect(decodeSession(body)).toBeNull();
  });

  /** The forgery that matters: a valid payload someone wrote themselves. */
  it("rejects a payload signed with the wrong key", async () => {
    const { newSession } = await load();
    const cookie = newSession(USER, TENANT as never);

    process.env["SESSION_SECRET"] = "a-different-secret";
    vi.resetModules();
    const { decodeSession } = await load();
    expect(decodeSession(cookie)).toBeNull();
  });

  it("rejects a tampered payload that keeps the old signature", async () => {
    const { newSession, decodeSession } = await load();
    const [, signature] = newSession(USER, TENANT as never).split(".");
    const forged = Buffer.from(
      JSON.stringify({
        uid: USER,
        tid: "ffffffff-0000-4000-8000-00000000000f",
        iat: Date.now(),
        exp: Date.now() + 10_000,
      }),
    ).toString("base64url");
    expect(decodeSession(`${forged}.${signature}`)).toBeNull();
  });

  it("rejects an expired session", async () => {
    const { encodeSession, decodeSession } = await load();
    const cookie = encodeSession({
      uid: USER,
      tid: TENANT,
      iat: Date.now() - 100_000,
      exp: Date.now() - 1,
    });
    expect(decodeSession(cookie)).toBeNull();
  });

  /**
   * A validly-signed cookie whose tenant is not a tenant id. Signed by us, so
   * it passes the HMAC - and would reach the database as a query parameter if
   * the payload were trusted on the strength of the signature alone.
   */
  it("rejects a signed cookie whose tenant is malformed", async () => {
    const { encodeSession, decodeSession } = await load();
    const cookie = encodeSession({
      uid: USER,
      tid: "'; DROP TABLE tenants; --",
      iat: Date.now(),
      exp: Date.now() + 10_000,
    });
    expect(decodeSession(cookie)).toBeNull();
  });

  it("rejects a payload that is not JSON", async () => {
    const { decodeSession } = await load();
    const body = Buffer.from("not json at all").toString("base64url");
    const { encodeSession } = await load();
    void encodeSession;
    expect(decodeSession(`${body}.whatever`)).toBeNull();
  });
});

describe("cookie attributes", () => {
  it("is httpOnly and lax, so the callback from Google still carries it", async () => {
    const { cookieOptions } = await load();
    const opts = cookieOptions();
    expect(opts.httpOnly).toBe(true);
    // `strict` would withhold the cookie on the top-level navigation back from
    // Google, which is the one request that must carry it.
    expect(opts.sameSite).toBe("lax");
  });

  it("is not Secure when the origin is plain http", async () => {
    process.env["PUBLIC_BASE_URL"] = "http://localhost:5173";
    vi.resetModules();
    const { cookieOptions } = await load();
    // A Secure cookie over plain http is silently dropped, which presents as
    // "signing in does nothing" - the least debuggable failure available.
    expect(cookieOptions().secure).toBe(false);
  });

  it("is Secure when the origin is https", async () => {
    process.env["PUBLIC_BASE_URL"] = "https://dave.example";
    vi.resetModules();
    const { cookieOptions } = await load();
    expect(cookieOptions().secure).toBe(true);
  });

  /**
   * The case that motivated following the scheme rather than the mode:
   * `http://<tailnet-ip>` is not a secure context, unlike `localhost`, so a
   * Secure cookie there is dropped and sign-in appears to do nothing at all.
   */
  it("is not Secure on a bare http IP, which is not a secure context", async () => {
    process.env["PUBLIC_BASE_URL"] = "http://100.64.1.5:5173";
    vi.resetModules();
    const { cookieOptions } = await load();
    expect(cookieOptions().secure).toBe(false);
  });
});
