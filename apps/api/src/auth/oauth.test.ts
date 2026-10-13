/**
 * The parts of the flow that are the same for every provider.
 *
 * All pure, so each rule is checked without a network or a registered OAuth
 * app — which is the point of keeping them in their own module.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL = { ...process.env };

beforeEach(() => {
  process.env["SESSION_SECRET"] = "a-long-test-secret-for-signing-state";
  process.env["PUBLIC_BASE_URL"] = "https://sightline.test";
  process.env["GOOGLE_CLIENT_ID"] = "google-id";
  process.env["GOOGLE_CLIENT_SECRET"] = "google-secret";
  delete process.env["GITHUB_CLIENT_ID"];
  delete process.env["GITHUB_CLIENT_SECRET"];
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.resetModules();
});

const load = () => import("./oauth.js");

describe("the redirect URI", () => {
  it("comes from configuration, never from the request", async () => {
    const { redirectUri } = await load();
    // Deriving it from the Host header is the convenient thing to do and would
    // let a forged header send the authorization code somewhere else.
    expect(redirectUri("google")).toBe("https://sightline.test/api/auth/google/callback");
  });

  it("sits under /api/, which is the only prefix the frontend proxies", async () => {
    const { redirectUri } = await load();
    // A bare /auth/... would be served the SPA's index.html in the
    // containerised deployment and the callback would never arrive.
    expect(redirectUri("github")).toContain("/api/auth/");
  });

  it("tolerates a trailing slash in the configured base", async () => {
    process.env["PUBLIC_BASE_URL"] = "https://sightline.test/";
    vi.resetModules();
    const { redirectUri } = await load();
    expect(redirectUri("google")).toBe("https://sightline.test/api/auth/google/callback");
  });
});

describe("the state parameter", () => {
  it("round-trips", async () => {
    const { createState, verifyState } = await load();
    expect(verifyState(createState("google"), "google")).toBe(true);
  });

  it("cannot be minted without the secret", async () => {
    const { createState } = await load();
    const forged = createState("google");
    process.env["SESSION_SECRET"] = "a-different-secret-entirely";
    vi.resetModules();
    const { verifyState } = await load();
    expect(verifyState(forged, "google")).toBe(false);
  });

  it("cannot be presented to a different provider", async () => {
    const { createState, verifyState } = await load();
    // Otherwise a state issued for the provider an attacker controls could be
    // replayed against the one they want.
    expect(verifyState(createState("google"), "github")).toBe(false);
  });

  it("refuses a tampered body", async () => {
    const { createState, verifyState } = await load();
    const state = createState("google");
    const parts = state.split(".");
    parts[1] = "tampered";
    expect(verifyState(parts.join("."), "google")).toBe(false);
  });

  it("refuses rubbish without throwing", async () => {
    const { verifyState } = await load();
    for (const bad of [undefined, "", "a", "a.b", "a.b.c", "....", "google.x.y.z"]) {
      expect(verifyState(bad, "google")).toBe(false);
    }
  });

  it("expires", async () => {
    const { createState, verifyState } = await load();
    const state = createState("google");
    expect(verifyState(state, "google")).toBe(true);
    // Eleven minutes on, past the ten-minute window.
    vi.setSystemTime(new Date(Date.now() + 11 * 60 * 1000));
    expect(verifyState(state, "google")).toBe(false);
    vi.useRealTimers();
  });

  it("refuses a state from the future, which is a clock or a forgery", async () => {
    const { createState, verifyState } = await load();
    vi.setSystemTime(new Date(Date.now() + 60 * 60 * 1000));
    const future = createState("google");
    vi.useRealTimers();
    expect(verifyState(future, "google")).toBe(false);
  });

  it("refuses to sign anything without a secret", async () => {
    delete process.env["SESSION_SECRET"];
    vi.resetModules();
    const { createState } = await load();
    expect(() => createState("google")).toThrow(/SESSION_SECRET/);
  });
});

describe("which providers exist", () => {
  it("lists only the ones with both halves configured", async () => {
    const { configuredProviders } = await load();
    expect(configuredProviders()).toEqual(["google"]);
  });

  it("does not count half a provider", async () => {
    process.env["GITHUB_CLIENT_ID"] = "github-id";
    vi.resetModules();
    const { configuredProviders, providerConfigured } = await load();
    expect(providerConfigured("github")).toBe(false);
    expect(configuredProviders()).toEqual(["google"]);
  });

  it("refuses to hand out credentials it does not have", async () => {
    const { clientCredentials } = await load();
    expect(() => clientCredentials("github")).toThrow(/not configured/);
  });
});
