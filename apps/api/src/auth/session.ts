/**
 * Sessions as a signed cookie.
 *
 * No server-side session store, deliberately: several API replicas behind one
 * ingress would otherwise need a shared one, and the only thing a session
 * holds here is "which user is this" - two identifiers, no secrets. Nothing
 * from Google (no access token, no id token) and nothing of the tenant's (no
 * API key, no external id) ever goes in the cookie or reaches the browser.
 *
 * The format is `base64url(payload).base64url(hmac)` - the shape a JWT would
 * have, without a library, because the parts of JWT that earn a library
 * (algorithm negotiation, key rotation, third-party verification) are exactly
 * the parts not wanted here. One algorithm, one key, one issuer, one audience.
 * `alg: none` and algorithm-confusion attacks are impossible for the same
 * reason: there is no algorithm field to confuse.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { cfg } from "../config.js";
import { asTenantId, type TenantId } from "../tenancy/tenant.js";

export const SESSION_COOKIE = "daveio_session";

/** Eight hours: a working day, and short enough that a stolen cookie expires. */
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export interface SessionPayload {
  /** The user row. */
  uid: string;
  /** The tenant they act for, denormalised so every request need not hit Postgres. */
  tid: string;
  iat: number;
  exp: number;
}

export interface Session {
  userId: string;
  tenantId: TenantId;
  expiresAt: Date;
}

function key(): Buffer {
  const secret = cfg.SESSION_SECRET;
  if (!secret) {
    throw new Error(
      "SESSION_SECRET is not set. Sessions are signed cookies, so a secret is required " +
        "before anyone can sign in.",
    );
  }
  return Buffer.from(secret, "utf8");
}

function sign(body: string): string {
  return createHmac("sha256", key()).update(body).digest("base64url");
}

export function encodeSession(payload: SessionPayload): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${sign(body)}`;
}

/**
 * Decode a cookie, or return null.
 *
 * Every failure - malformed, wrong signature, expired, nonsense payload -
 * returns null rather than throwing or distinguishing itself. The caller's
 * only correct response to any of them is "not signed in", and a specific
 * error would tell an attacker which part of their forgery to fix.
 */
export function decodeSession(cookie: string | undefined): Session | null {
  if (!cookie) return null;
  const [body, signature] = cookie.split(".");
  if (!body || !signature) return null;

  const expected = Buffer.from(sign(body), "utf8");
  const actual = Buffer.from(signature, "utf8");
  // Constant-time, and length-checked first because timingSafeEqual throws on
  // a length mismatch - which would itself be a timing signal.
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
  } catch {
    return null;
  }

  if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
  if (typeof payload.uid !== "string" || typeof payload.tid !== "string") return null;

  try {
    return {
      userId: payload.uid,
      tenantId: asTenantId(payload.tid),
      expiresAt: new Date(payload.exp),
    };
  } catch {
    return null;
  }
}

export function newSession(userId: string, tenantId: TenantId): string {
  const now = Date.now();
  return encodeSession({ uid: userId, tid: tenantId, iat: now, exp: now + SESSION_TTL_MS });
}

/**
 * Cookie attributes.
 *
 * `secure` follows the **scheme this service is actually served on**, not the
 * deployment mode. A Secure cookie sent over plain http is dropped silently by
 * the browser, which presents as "signing in does nothing" - the least
 * debuggable failure available - and `http://<tailnet-ip>` is exactly the case
 * where that bites, because unlike `localhost` it is not a secure context.
 *
 * So the rule is the honest one: https means Secure, anything else does not.
 * A hosted deployment behind Cloudflare is always https and gets the flag; a
 * developer testing the hosted code path over http does not, and their login
 * works.
 *
 * `sameSite: lax` rather than `strict` because the OAuth callback is a
 * top-level navigation *from Google*, and `strict` would withhold the cookie
 * on exactly that request.
 */
/**
 * Is the public origin https?
 *
 * Unset (a self-hosted developer with no PUBLIC_BASE_URL) means no, which is
 * right: there is no sign-in there to protect.
 */
export function servedOverHttps(): boolean {
  return (cfg.PUBLIC_BASE_URL ?? "").startsWith("https://");
}

export function cookieOptions(): {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: servedOverHttps(),
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}
