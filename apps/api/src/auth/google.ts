/**
 * Google OAuth 2.0, authorization code flow.
 *
 * Written against the protocol rather than through a library, for the same
 * reason the agent has no framework: the whole flow is three URLs and two
 * checks, and the parts worth getting right are the checks - which a library
 * would perform somewhere I would then have to go and read anyway.
 *
 * Google is the only provider. No password ever reaches this service, and
 * there is nothing here to breach: the `users` row holds a provider subject
 * and an email address.
 *
 * What is deliberately *not* done: verifying the id token's RSA signature
 * against Google's JWKS. The token is not accepted from the browser - it is
 * fetched by this server, over TLS, directly from `oauth2.googleapis.com`, in
 * exchange for a code and this service's client secret. Google's own
 * documentation says verification is unnecessary for exactly this case. The
 * claims that still matter (`iss`, `aud`, `exp`) are checked, because they
 * cost nothing and catch a token that arrived from the right place for the
 * wrong application.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { cfg } from "../config.js";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

export interface GoogleIdentity {
  /** Google's stable identifier. The join key - an email address is not. */
  subject: string;
  email: string | null;
  emailVerified: boolean;
}

export function googleConfigProblem(): string | null {
  if (!cfg.GOOGLE_CLIENT_ID) return "GOOGLE_CLIENT_ID is not set";
  if (!cfg.GOOGLE_CLIENT_SECRET) return "GOOGLE_CLIENT_SECRET is not set";
  if (!cfg.PUBLIC_BASE_URL)
    return "PUBLIC_BASE_URL is not set, so the redirect URI cannot be built";
  if (!cfg.SESSION_SECRET) return "SESSION_SECRET is not set, so sessions cannot be signed";
  return null;
}

/**
 * The redirect URI, built from configuration and never from the request.
 *
 * Google requires it to match a registered value exactly. Deriving it from the
 * `Host` header instead - which is the convenient thing to do - would let a
 * forged header send the authorization code somewhere else.
 */
export function redirectUri(): string {
  const base = (cfg.PUBLIC_BASE_URL ?? "").replace(/\/$/, "");
  return `${base}/auth/google/callback`;
}

/**
 * CSRF protection for the round trip.
 *
 * `state` is random and signed rather than stored, so the callback can verify
 * it without a session store or a database row: the same reason sessions are
 * signed cookies. An attacker cannot mint one without the secret, and a replay
 * of an old one fails on the timestamp.
 */
const STATE_TTL_MS = 10 * 60 * 1000;

export function createState(): string {
  const nonce = randomBytes(16).toString("base64url");
  const body = `${nonce}.${Date.now()}`;
  const mac = createHmac("sha256", cfg.SESSION_SECRET ?? "")
    .update(body)
    .digest("base64url");
  return `${body}.${mac}`;
}

export function verifyState(state: string | undefined): boolean {
  if (!state) return false;
  const parts = state.split(".");
  if (parts.length !== 3) return false;
  const [nonce, issuedAt, mac] = parts as [string, string, string];

  const expected = Buffer.from(
    createHmac("sha256", cfg.SESSION_SECRET ?? "")
      .update(`${nonce}.${issuedAt}`)
      .digest("base64url"),
    "utf8",
  );
  const actual = Buffer.from(mac, "utf8");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;

  const age = Date.now() - Number(issuedAt);
  return Number.isFinite(age) && age >= 0 && age < STATE_TTL_MS;
}

/** Where to send the browser to begin. */
export function authorizationUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: cfg.GOOGLE_CLIENT_ID ?? "",
    redirect_uri: redirectUri(),
    response_type: "code",
    // The minimum that identifies a person. No Drive, no contacts, no offline
    // access: this service never acts on a user's behalf at Google, so a
    // refresh token would be a credential held for no reason.
    scope: "openid email",
    state,
    // Google returns a refresh token only with access_type=offline, which is
    // omitted on purpose.
    prompt: "select_account",
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

/** Decode a JWT payload without verifying - see the note at the top of the file. */
function decodeIdTokenPayload(idToken: string): Record<string, unknown> | null {
  const part = idToken.split(".")[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Claims that must hold even for a token fetched directly from Google.
 *
 * `aud` is the one that matters: a token minted for a *different* Google
 * application is genuinely from Google and genuinely signed, and accepting it
 * would let anyone with their own Google app sign in as anybody here.
 */
export function identityFromClaims(claims: Record<string, unknown>): GoogleIdentity | null {
  const iss = typeof claims["iss"] === "string" ? claims["iss"] : "";
  const aud = typeof claims["aud"] === "string" ? claims["aud"] : "";
  const sub = typeof claims["sub"] === "string" ? claims["sub"] : "";
  const exp = typeof claims["exp"] === "number" ? claims["exp"] : 0;

  if (!ISSUERS.has(iss)) return null;
  if (!aud || aud !== cfg.GOOGLE_CLIENT_ID) return null;
  if (!sub) return null;
  if (!exp || exp * 1000 < Date.now()) return null;

  return {
    subject: sub,
    email: typeof claims["email"] === "string" ? claims["email"] : null,
    emailVerified: claims["email_verified"] === true,
  };
}

/**
 * Exchange the authorization code for an identity.
 *
 * `fetchImpl` is injectable so the exchange can be tested without a network or
 * a Google project - the interesting logic is what happens to the response,
 * not the POST itself.
 */
export async function exchangeCode(
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GoogleIdentity> {
  const res = await fetchImpl(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: cfg.GOOGLE_CLIENT_ID ?? "",
      client_secret: cfg.GOOGLE_CLIENT_SECRET ?? "",
      redirect_uri: redirectUri(),
      grant_type: "authorization_code",
    }),
  });

  if (!res.ok) {
    // Google's error body names the cause - redirect_uri_mismatch,
    // invalid_client - and it is the difference between ten minutes and an
    // afternoon. It goes in the log, never to the browser.
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Google rejected the authorization code (${res.status}): ${detail.slice(0, 300)}`,
    );
  }

  const body = (await res.json()) as { id_token?: string };
  if (!body.id_token) throw new Error("Google returned no id_token");

  const claims = decodeIdTokenPayload(body.id_token);
  if (!claims) throw new Error("Google returned an id_token that could not be decoded");

  const identity = identityFromClaims(claims);
  if (!identity)
    throw new Error("Google returned an id_token for a different application or issuer");
  return identity;
}
