/**
 * What each provider needs, and what it gives back.
 *
 * The two differ more than they look. Google returns an OIDC `id_token` whose
 * claims are the identity; GitHub returns only an access token, and the
 * identity is two further API calls - the second because a GitHub user's
 * primary address is not in the `/user` response unless it is public.
 *
 * `fetchImpl` is injectable throughout, so the exchange is testable without a
 * network or a registered OAuth app. The interesting logic is what happens to
 * the response, not the POST.
 */

import { cfg } from "../core/config.js";
import {
  clientCredentials,
  pkceChallenge,
  redirectUri,
  type ExternalIdentity,
  type ProviderName,
} from "./oauth.js";

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

/**
 * GitHub's endpoints, or the browser suite's stand-in for them, which hosted
 * mode permits only on loopback (`hostedMode.ts`). Read per call so a test can
 * set it after this module loads.
 */
function github(path: "authorize" | "token" | "user" | "emails"): string {
  const stub = cfg.E2E_IDENTITY_PROVIDER_URL?.replace(/\/$/, "");
  if (stub) return `${stub}/github/${path}`;
  return {
    authorize: "https://github.com/login/oauth/authorize",
    token: "https://github.com/login/oauth/access_token",
    user: "https://api.github.com/user",
    emails: "https://api.github.com/user/emails",
  }[path];
}

/** Where to send the browser to begin. */
export function authorizationUrl(provider: ProviderName, state: string): string {
  const { id } = clientCredentials(provider);
  if (provider === "google") {
    return `${GOOGLE_AUTH}?${new URLSearchParams({
      client_id: id,
      redirect_uri: redirectUri("google"),
      response_type: "code",
      /**
       * The minimum that identifies a person.
       *
       * No Drive, no contacts, no offline access - this service never acts on
       * anyone's behalf at Google, so a refresh token would be a credential
       * held for no reason. These are also *basic* scopes, which is why the
       * consent screen needs no Google verification review.
       */
      scope: "openid email profile",
      state,
      code_challenge: pkceChallenge(state),
      code_challenge_method: "S256",
      prompt: "select_account",
    }).toString()}`;
  }
  return `${github("authorize")}?${new URLSearchParams({
    client_id: id,
    redirect_uri: redirectUri("github"),
    scope: "read:user user:email",
    state,
    code_challenge: pkceChallenge(state),
    code_challenge_method: "S256",
  }).toString()}`;
}

/** Decode a JWT payload without verifying the signature - see `identityFromGoogleClaims`. */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split(".")[1];
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
 * The RSA signature is deliberately **not** verified against Google's JWKS.
 * The token is never accepted from the browser: this server fetched it, over
 * TLS, from `oauth2.googleapis.com`, in exchange for a code and this service's
 * client secret. Google's own documentation says verification is unnecessary in
 * exactly that case.
 *
 * `aud` is the claim that still matters, and it matters a lot: a token minted
 * for a *different* Google application is genuinely from Google and genuinely
 * signed, and accepting it would let anyone with their own Google app sign in
 * as anybody here.
 *
 * Pure, so each rule is testable without a network.
 */
export function identityFromGoogleClaims(claims: Record<string, unknown>): ExternalIdentity | null {
  const str = (key: string) => (typeof claims[key] === "string" ? claims[key] : "");
  const iss = str("iss");
  const aud = str("aud");
  const sub = str("sub");
  const exp = typeof claims["exp"] === "number" ? claims["exp"] : 0;

  if (!GOOGLE_ISSUERS.has(iss)) return null;
  if (!aud || aud !== cfg.GOOGLE_CLIENT_ID) return null;
  if (!sub) return null;
  if (!exp || exp * 1000 < Date.now()) return null;

  return {
    provider: "google",
    subject: sub,
    email: str("email") || null,
    emailVerified: claims["email_verified"] === true,
    name: str("name") || null,
    avatarUrl: str("picture") || null,
  };
}

async function postForm(
  url: string,
  body: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(body),
  });
  if (!res.ok) {
    /**
     * The provider's error body names the cause - `redirect_uri_mismatch`,
     * `invalid_client` - and that is the difference between ten minutes and an
     * afternoon. It goes in the exception, which is logged; the browser is told
     * only that sign-in failed.
     */
    const detail = await res.text().catch(() => "");
    throw new Error(`token exchange failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

async function exchangeGoogle(
  code: string,
  verifier: string,
  fetchImpl: typeof fetch,
): Promise<ExternalIdentity> {
  const { id, secret } = clientCredentials("google");
  const body = await postForm(
    GOOGLE_TOKEN,
    {
      code,
      client_id: id,
      client_secret: secret,
      redirect_uri: redirectUri("google"),
      grant_type: "authorization_code",
      code_verifier: verifier,
    },
    fetchImpl,
  );

  const idToken = typeof body["id_token"] === "string" ? body["id_token"] : null;
  if (!idToken) throw new Error("Google returned no id_token");
  const claims = decodeJwtPayload(idToken);
  if (!claims) throw new Error("Google returned an id_token that could not be decoded");
  const identity = identityFromGoogleClaims(claims);
  if (!identity) {
    throw new Error("Google returned an id_token for a different application or issuer");
  }
  return identity;
}

/** GitHub's `/user`, reduced to what this service stores. */
export function identityFromGithubUser(
  user: Record<string, unknown>,
  email: { address: string; verified: boolean } | null,
): ExternalIdentity | null {
  // A numeric id, which GitHub keeps stable across renames - unlike `login`,
  // which a user can change and somebody else can then take.
  const id = user["id"];
  if (typeof id !== "number" && typeof id !== "string") return null;
  const str = (key: string) => (typeof user[key] === "string" ? user[key] : "");
  return {
    provider: "github",
    subject: String(id),
    email: email?.address ?? null,
    emailVerified: email?.verified ?? false,
    name: str("name") || str("login") || null,
    avatarUrl: str("avatar_url") || null,
  };
}

/**
 * The address GitHub considers primary, and whether it is verified.
 *
 * A separate call because `/user` omits the address entirely unless the user
 * made it public, so relying on it would leave most accounts with no email at
 * all.
 */
export function primaryGithubEmail(emails: unknown): { address: string; verified: boolean } | null {
  if (!Array.isArray(emails)) return null;
  const rows = emails.filter(
    (e): e is Record<string, unknown> => Boolean(e) && typeof e === "object",
  );
  const chosen =
    rows.find((e) => e["primary"] === true && e["verified"] === true) ??
    rows.find((e) => e["verified"] === true);
  const address = chosen && typeof chosen["email"] === "string" ? chosen["email"] : null;
  return address ? { address, verified: true } : null;
}

async function exchangeGithub(
  code: string,
  verifier: string,
  fetchImpl: typeof fetch,
): Promise<ExternalIdentity> {
  const { id, secret } = clientCredentials("github");
  const body = await postForm(
    github("token"),
    {
      code,
      client_id: id,
      client_secret: secret,
      redirect_uri: redirectUri("github"),
      code_verifier: verifier,
    },
    fetchImpl,
  );
  const token = typeof body["access_token"] === "string" ? body["access_token"] : null;
  if (!token) throw new Error("GitHub returned no access_token");

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "sightline",
  };
  const [userRes, emailRes] = await Promise.all([
    fetchImpl(github("user"), { headers }),
    fetchImpl(github("emails"), { headers }),
  ]);
  if (!userRes.ok) throw new Error(`GitHub /user failed (${userRes.status})`);

  const user = (await userRes.json()) as Record<string, unknown>;
  // A failure here is not fatal: an account with no verified address is still
  // an identity, and the caller decides whether that is enough to sign in.
  const emails = emailRes.ok ? await emailRes.json().catch(() => null) : null;

  const identity = identityFromGithubUser(user, primaryGithubEmail(emails));
  if (!identity) throw new Error("GitHub returned a user with no usable id");
  return identity;
}

/** `verifier` is the PKCE verifier for the state the flow began with - `pkceVerifier`. */
export function exchangeCode(
  provider: ProviderName,
  code: string,
  verifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ExternalIdentity> {
  return provider === "google"
    ? exchangeGoogle(code, verifier, fetchImpl)
    : exchangeGithub(code, verifier, fetchImpl);
}
