/**
 * The Google flow, tested where it can be wrong.
 *
 * Not tested: that a POST to Google's token endpoint works. That is Google's
 * behaviour and a network call, and a mock of it would assert that this file
 * calls `fetch` the way this file calls `fetch`. What *is* tested is
 * everything a mistake in this file would let through - a forged callback, a
 * token minted for somebody else's application, a redirect URI that quietly
 * follows the request instead of the configuration.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL = { ...process.env };

beforeEach(() => {
  process.env["SESSION_SECRET"] = "test-session-secret-not-a-real-one";
  process.env["GOOGLE_CLIENT_ID"] = "1234.apps.googleusercontent.com";
  process.env["GOOGLE_CLIENT_SECRET"] = "not-a-real-client-secret";
  process.env["PUBLIC_BASE_URL"] = "https://dave.example";
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.resetModules();
});

const load = () => import("./google.js");

describe("the redirect URI", () => {
  it("comes from configuration, so a forged Host header cannot move it", async () => {
    const { redirectUri } = await load();
    expect(redirectUri()).toBe("https://dave.example/auth/google/callback");
  });

  it("tolerates a trailing slash in the configured base", async () => {
    process.env["PUBLIC_BASE_URL"] = "https://dave.example/";
    vi.resetModules();
    const { redirectUri } = await load();
    // Google matches this string exactly; a double slash is a different URI
    // and fails with redirect_uri_mismatch, an hour before anyone works out why.
    expect(redirectUri()).toBe("https://dave.example/auth/google/callback");
  });
});

describe("the authorization URL", () => {
  it("asks for the minimum that identifies a person", async () => {
    const { authorizationUrl, createState } = await load();
    const url = new URL(authorizationUrl(createState()));
    expect(url.searchParams.get("scope")).toBe("openid email");
    expect(url.searchParams.get("response_type")).toBe("code");
  });

  it("does not request offline access", async () => {
    const { authorizationUrl, createState } = await load();
    const url = new URL(authorizationUrl(createState()));
    // A refresh token is a long-lived credential, and this service never acts
    // at Google on a user's behalf - so holding one would be risk for nothing.
    expect(url.searchParams.get("access_type")).toBeNull();
  });
});

describe("state, which is the CSRF defence for the round trip", () => {
  it("accepts one it just issued", async () => {
    const { createState, verifyState } = await load();
    expect(verifyState(createState())).toBe(true);
  });

  it("rejects a missing or malformed state", async () => {
    const { verifyState } = await load();
    expect(verifyState(undefined)).toBe(false);
    expect(verifyState("")).toBe(false);
    expect(verifyState("nonsense")).toBe(false);
    expect(verifyState("a.b")).toBe(false);
  });

  it("rejects one an attacker minted without the secret", async () => {
    const { verifyState } = await load();
    expect(verifyState(`abc.${Date.now()}.forged-signature`)).toBe(false);
  });

  it("rejects one that has been sitting in a tab for hours", async () => {
    const { createState, verifyState } = await load();
    const state = createState();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    expect(verifyState(state)).toBe(false);
    vi.useRealTimers();
  });

  it("rejects one issued under a different secret", async () => {
    const { createState } = await load();
    const state = createState();
    process.env["SESSION_SECRET"] = "another-secret";
    vi.resetModules();
    const { verifyState } = await load();
    expect(verifyState(state)).toBe(false);
  });
});

describe("the claims in an id token", () => {
  const valid = () => ({
    iss: "https://accounts.google.com",
    aud: "1234.apps.googleusercontent.com",
    sub: "107654321",
    email: "someone@example.com",
    email_verified: true,
    exp: Math.floor(Date.now() / 1000) + 3600,
  });

  it("accepts a token for this application", async () => {
    const { identityFromClaims } = await load();
    const identity = identityFromClaims(valid());
    expect(identity?.subject).toBe("107654321");
    expect(identity?.email).toBe("someone@example.com");
  });

  /**
   * The check that matters most. A token minted for a *different* Google
   * application is genuinely from Google and genuinely signed - accepting it
   * would let anyone with their own Google app sign in as anybody here.
   */
  it("rejects a token minted for a different application", async () => {
    const { identityFromClaims } = await load();
    expect(identityFromClaims({ ...valid(), aud: "9999.apps.googleusercontent.com" })).toBeNull();
  });

  it("rejects a token from a different issuer", async () => {
    const { identityFromClaims } = await load();
    expect(identityFromClaims({ ...valid(), iss: "https://accounts.evil.example" })).toBeNull();
  });

  it("rejects an expired token", async () => {
    const { identityFromClaims } = await load();
    expect(identityFromClaims({ ...valid(), exp: Math.floor(Date.now() / 1000) - 10 })).toBeNull();
  });

  it("rejects a token with no subject", async () => {
    const { identityFromClaims } = await load();
    const { sub, ...withoutSub } = valid();
    void sub;
    expect(identityFromClaims(withoutSub)).toBeNull();
  });

  /**
   * An unverified address is not proof of anything, and the subject is what
   * this service joins on - so the identity is still usable, with the flag
   * carried through rather than silently dropped.
   */
  it("keeps an unverified address but marks it", async () => {
    const { identityFromClaims } = await load();
    const identity = identityFromClaims({ ...valid(), email_verified: false });
    expect(identity?.emailVerified).toBe(false);
  });
});

describe("configuration", () => {
  it("names the missing variable rather than failing vaguely", async () => {
    delete process.env["GOOGLE_CLIENT_ID"];
    vi.resetModules();
    const { googleConfigProblem } = await load();
    expect(googleConfigProblem()).toContain("GOOGLE_CLIENT_ID");
  });

  it("is satisfied when everything is present", async () => {
    const { googleConfigProblem } = await load();
    expect(googleConfigProblem()).toBeNull();
  });
});

describe("exchanging the code", () => {
  it("rejects a token response for another application", async () => {
    const { exchangeCode } = await load();
    const claims = {
      iss: "https://accounts.google.com",
      aud: "someone-elses-app.apps.googleusercontent.com",
      sub: "1",
      exp: Math.floor(Date.now() / 1000) + 600,
    };
    const idToken = `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ id_token: idToken }), { status: 200 })) as typeof fetch;

    await expect(exchangeCode("code", fakeFetch)).rejects.toThrow(/different application/);
  });

  it("surfaces Google's own error text to the log, not the browser", async () => {
    const { exchangeCode } = await load();
    const fakeFetch = (async () =>
      new Response("redirect_uri_mismatch", { status: 400 })) as typeof fetch;
    // The message names the cause - it is the difference between ten minutes
    // and an afternoon - and the route logs it rather than returning it.
    await expect(exchangeCode("code", fakeFetch)).rejects.toThrow(/redirect_uri_mismatch/);
  });
});
