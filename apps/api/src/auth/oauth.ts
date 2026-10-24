/**
 * The authorization-code flow, the parts that are the same for every provider.
 *
 * Written against the protocol rather than through a library, for the same
 * reason the agent has no framework: the flow is three URLs and two checks, and
 * the checks are the part worth getting right - which a library performs
 * somewhere you have to go and read anyway to know what it actually verifies.
 *
 * No password ever reaches this service, and there is nothing here to breach: a
 * `users` row holds an email address and a provider's subject.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { cfg } from "../core/config.js";

/** How long a round trip to the provider may take. */
const STATE_TTL_MS = 10 * 60 * 1000;

export type ProviderName = "google" | "github";

/** Who the provider says this is. */
export interface ExternalIdentity {
  provider: ProviderName;
  /** The provider's stable identifier. The join key - an email address is not. */
  subject: string;
  email: string | null;
  /**
   * Whether the provider asserts the address is theirs.
   *
   * Load-bearing: an unverified address is not evidence of anything, and a
   * `users.email` is unique, so accepting one would let somebody claim a slot
   * that is not theirs.
   */
  emailVerified: boolean;
  name: string | null;
  avatarUrl: string | null;
}

function secret(): string {
  const value = cfg.SESSION_SECRET;
  if (!value) {
    throw new Error(
      "SESSION_SECRET is not set, so the OAuth `state` cannot be signed and nobody can sign in.",
    );
  }
  return value;
}

/**
 * The redirect URI, built from configuration and never from the request.
 *
 * Providers require it to match a registered value exactly. Deriving it from
 * the `Host` header instead - the convenient thing to do - would let a forged
 * header send the authorization code somewhere else.
 *
 * Under `/api/` because that is the only prefix the frontend's nginx proxies;
 * a bare `/auth/...` would be served the SPA's index.html in the containerised
 * deployment and the callback would silently never arrive.
 */
export function redirectUri(provider: ProviderName): string {
  const base = cfg.PUBLIC_BASE_URL.replace(/\/$/, "");
  return `${base}/api/auth/${provider}/callback`;
}

/**
 * The cookie that ties a sign-in to the browser that started it.
 *
 * A signed state alone proves this service issued it, not that *this browser*
 * asked for it: an attacker could start a sign-in, approve it with their own
 * account, and send the callback URL to a victim, who would land signed in to
 * the attacker's workspace - and connect their AWS account into it. The state's
 * MAC covers this cookie's value, so the callback verifies only in the browser
 * holding it. Starting sign-in in a second tab replaces it; the first tab's
 * callback then reads as expired, and trying again works.
 */
export const OAUTH_COOKIE = "sightline_oauth";

export function newBinding(): string {
  return randomBytes(32).toString("base64url");
}

function mac(body: string, binding: string): string {
  return createHmac("sha256", secret()).update(`${body}.${binding}`).digest("base64url");
}

/**
 * CSRF protection for the round trip.
 *
 * Random and signed rather than stored, so the callback verifies it without a
 * row to clean up: an attacker cannot mint one without the secret, and a replay
 * of an old one fails on the timestamp. The provider is inside the signed body,
 * so a state issued for one provider cannot be presented to another.
 */
export function createState(provider: ProviderName, binding: string): string {
  const body = `${provider}.${randomBytes(16).toString("base64url")}.${Date.now()}`;
  return `${body}.${mac(body, binding)}`;
}

/**
 * The PKCE verifier for a state, derived rather than stored.
 *
 * Someone who intercepts the callback URL has the code and the state, but not
 * the secret, so cannot produce the verifier the token endpoint demands.
 */
export function pkceVerifier(state: string): string {
  return createHmac("sha256", secret()).update(`pkce.${state}`).digest("base64url");
}

export function pkceChallenge(state: string): string {
  return createHash("sha256").update(pkceVerifier(state)).digest("base64url");
}

export function verifyState(
  state: string | undefined,
  provider: ProviderName,
  binding: string | undefined,
): boolean {
  if (!state || !binding) return false;
  const parts = state.split(".");
  if (parts.length !== 4) return false;
  const [named, nonce, issuedAt, signature] = parts as [string, string, string, string];
  if (named !== provider) return false;

  const expected = Buffer.from(mac(`${named}.${nonce}.${issuedAt}`, binding), "utf8");
  const actual = Buffer.from(signature, "utf8");
  // Length-checked first because `timingSafeEqual` throws on a mismatch, which
  // would itself be a timing signal.
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;

  const age = Date.now() - Number(issuedAt);
  return Number.isFinite(age) && age >= 0 && age < STATE_TTL_MS;
}

/** Is this provider usable in this deployment? */
export function providerConfigured(provider: ProviderName): boolean {
  return provider === "google"
    ? Boolean(cfg.GOOGLE_CLIENT_ID && cfg.GOOGLE_CLIENT_SECRET)
    : Boolean(cfg.GITHUB_CLIENT_ID && cfg.GITHUB_CLIENT_SECRET);
}

export function configuredProviders(): ProviderName[] {
  return (["google", "github"] as const).filter(providerConfigured);
}

export function clientCredentials(provider: ProviderName): { id: string; secret: string } {
  const id = provider === "google" ? cfg.GOOGLE_CLIENT_ID : cfg.GITHUB_CLIENT_ID;
  const value = provider === "google" ? cfg.GOOGLE_CLIENT_SECRET : cfg.GITHUB_CLIENT_SECRET;
  if (!id || !value) throw new Error(`${provider} sign-in is not configured`);
  return { id, secret: value };
}
