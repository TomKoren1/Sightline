/**
 * Sessions, stored server-side so one can be revoked.
 *
 * A signed stateless cookie would need no table and no lookup, and it is what
 * this project's earlier attempt used. It cannot be revoked. For a service that
 * holds standing read access to other people's AWS accounts, "sign out
 * everywhere" and "kill that session now" are worth one indexed lookup per
 * request.
 *
 * The cookie carries a random token; only its **hash** is stored, so a dump of
 * this table is not a set of usable sessions - the same reasoning as a password
 * digest, for the same reason.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, lt, sql } from "drizzle-orm";

import { cfg, useSecureCookies } from "../core/config.js";
/**
 * `system`, not `db`, throughout this file.
 *
 * A session is looked up by the hash of its token, and the whole point of that
 * lookup is to *discover* which tenant is asking - there is no tenant context
 * to run it in, because this is what establishes one. The same is true of
 * creating a session at sign-in and of revoking one by its owner's user id, and
 * pruning expired sessions deliberately crosses every tenant.
 *
 * `sessions`, `users`, `identities` and `tenants` carry no row-level security
 * policy for exactly this reason: a policy comparing against `app.tenant_id`
 * would make signing in impossible. They are reached only from here and from
 * `users.ts`, which is a small enough surface to hold in one's head.
 */
import { system } from "../db/postgres.js";
import { sessions, tenants, users } from "../db/schema.js";
import { asTenantId } from "../core/ids.js";
import type { Session } from "../core/request.js";

export const SESSION_COOKIE = "sightline_session";

const hash = (token: string): Buffer => createHash("sha256").update(token).digest();

function ttlMs(): number {
  return cfg.SESSION_TTL_HOURS * 60 * 60 * 1000;
}

/**
 * Cookie attributes.
 *
 * `secure` follows the **scheme the service is served on**, not the deployment
 * mode. A Secure cookie over plain http is dropped silently by the browser,
 * which presents as "signing in does nothing" - the least debuggable failure
 * available - and `http://<lan-ip>` is exactly where it bites, because unlike
 * `localhost` it is not a secure context.
 *
 * `sameSite: lax` rather than `strict`, because the OAuth callback is a
 * top-level navigation *from the provider* and `strict` would withhold the
 * cookie on exactly that request. Lax still refuses to send the cookie on a
 * cross-site POST, which is the case that matters.
 */
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
    secure: useSecureCookies(),
    path: "/",
    maxAge: Math.floor(ttlMs() / 1000),
  };
}

/**
 * The sign-in flow's own cookie (`OAUTH_COOKIE`): scoped to the auth routes and
 * gone after the ten minutes a round trip to the provider may take. Lax for the
 * same reason as the session - the callback is a navigation from the provider.
 */
export function flowCookieOptions(): {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: useSecureCookies(),
    path: "/api/auth",
    maxAge: 600,
  };
}

/** Issue a session and return the token the cookie should carry. */
export async function issueSession(
  userId: string,
  context: { userAgent?: string | undefined; ip?: string | undefined } = {},
): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await system.insert(sessions).values({
    id: crypto.randomUUID(),
    tokenHash: hash(token),
    userId,
    expiresAt: new Date(Date.now() + ttlMs()),
    ...(context.userAgent ? { userAgent: context.userAgent.slice(0, 400) } : {}),
    ...(context.ip ? { ip: context.ip } : {}),
  });
  return token;
}

/**
 * The session a cookie names, or null.
 *
 * Every failure - absent, malformed, unknown, expired - returns null without
 * distinguishing itself. The caller's only correct response to any of them is
 * "not signed in", and a specific error would tell an attacker which part of
 * their forgery to fix.
 *
 * Joined to the tenant so `is_admin` comes from the database on every request
 * rather than from something the browser holds: a flag cached in a cookie is a
 * flag that stays true after it has been revoked.
 */
export async function readSession(token: string | undefined): Promise<Session | null> {
  if (!token) return null;

  const [row] = await system
    .select({
      id: sessions.id,
      tokenHash: sessions.tokenHash,
      userId: sessions.userId,
      expiresAt: sessions.expiresAt,
      lastUsedAt: sessions.lastUsedAt,
      createdAt: sessions.createdAt,
      tenantId: users.tenantId,
      email: users.email,
      role: users.role,
      isAdmin: tenants.isAdmin,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(tenants, eq(tenants.id, users.tenantId))
    .where(eq(sessions.tokenHash, hash(token)));

  if (!row) return null;

  /**
   * Compared again in constant time.
   *
   * The lookup above already matched on the hash, so this is belt and braces
   * rather than the primary check - but a hash comparison done by the database
   * is not constant-time, and this one costs nothing.
   */
  const expected = hash(token);
  if (row.tokenHash.length !== expected.length || !timingSafeEqual(row.tokenHash, expected)) {
    return null;
  }

  if (row.expiresAt.getTime() <= Date.now()) return null;

  // Touched at most every few minutes: a write on every request would turn a
  // read-only page load into a database write, for a timestamp nothing needs
  // to the second.
  const stale = !row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 5 * 60 * 1000;
  if (stale) {
    await system
      .update(sessions)
      .set({ lastUsedAt: new Date() })
      .where(eq(sessions.id, row.id))
      .catch(() => undefined);
  }

  return {
    id: row.id,
    userId: row.userId,
    tenantId: asTenantId(row.tenantId),
    email: row.email,
    isAdmin: row.isAdmin,
    role: row.role,
    expiresAt: row.expiresAt,
    signedInAt: row.createdAt,
  };
}

export async function revokeSession(token: string | undefined): Promise<void> {
  if (!token) return;
  await system.delete(sessions).where(eq(sessions.tokenHash, hash(token)));
}

/** Sign out everywhere, for one user. */
export async function revokeAllSessions(userId: string): Promise<number> {
  const deleted = await system.delete(sessions).where(eq(sessions.userId, userId)).returning({
    id: sessions.id,
  });
  return deleted.length;
}

/** One user's sessions, for a screen that lets them look and revoke. */
export async function listSessions(
  userId: string,
  currentToken: string | undefined,
): Promise<
  {
    id: string;
    createdAt: string;
    lastUsedAt: string | null;
    userAgent: string | null;
    current: boolean;
  }[]
> {
  const rows = await system
    .select({
      id: sessions.id,
      tokenHash: sessions.tokenHash,
      createdAt: sessions.createdAt,
      lastUsedAt: sessions.lastUsedAt,
      userAgent: sessions.userAgent,
    })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), sql`${sessions.expiresAt} > now()`));

  const current = currentToken ? hash(currentToken) : null;
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt.toISOString(),
    lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
    userAgent: r.userAgent,
    current: Boolean(current && r.tokenHash.equals(current)),
  }));
}

export async function revokeSessionById(userId: string, id: string): Promise<void> {
  // Scoped to the user, so an id from elsewhere revokes nothing.
  await system.delete(sessions).where(and(eq(sessions.id, id), eq(sessions.userId, userId)));
}

/**
 * Remove expired rows.
 *
 * They are already refused by `readSession`, so this is housekeeping rather
 * than a control - but a table that only grows is a table someone eventually
 * has to deal with at an inconvenient moment.
 */
export async function pruneExpiredSessions(): Promise<number> {
  const deleted = await system
    .delete(sessions)
    .where(lt(sessions.expiresAt, new Date()))
    .returning({ id: sessions.id });
  return deleted.length;
}
