/**
 * API tokens: `Authorization: Bearer slt_...`, for scripts and CI.
 *
 * A token acts for the person who created it, at the lesser of the role it was
 * given and the role they hold now - so demoting them demotes their tokens,
 * and removing them deletes them (the foreign key cascades). Shown once,
 * stored as a SHA-256 hash, looked up on `system` because the tenant is what
 * the lookup finds out. A token cannot manage tokens, the team or the account:
 * routes marked `@HumanOnly()` refuse it.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";

import { system } from "../db/postgres.js";
import { apiTokens, tenants, users } from "../db/schema.js";
import { asTenantId, type TenantId } from "../tenancy/ids.js";
import { atLeast, TEAM_ROLES, type TeamRole } from "./roles.js";
import type { Session } from "./session.js";

export const TOKEN_PREFIX = "slt_";
const MAX_TOKENS_PER_TENANT = 50;

const hash = (token: string): Buffer => createHash("sha256").update(token).digest();

/** A request the rules refuse; its message is for the person who made it. */
export class TokenRefused extends Error {}

const lesser = (a: TeamRole, b: TeamRole): TeamRole => (atLeast(a, b) ? b : a);

export async function createApiToken(
  session: Session,
  input: { name: string; role: TeamRole; expiresInDays: number | null },
): Promise<{ id: string; token: string; expiresAt: string | null }> {
  if (input.role === "owner") throw new TokenRefused("A token can be at most an admin.");
  if (!atLeast(session.role, input.role)) {
    throw new TokenRefused(`You are a ${session.role}, so you cannot make a ${input.role} token.`);
  }
  const existing = await system
    .select({ id: apiTokens.id })
    .from(apiTokens)
    .where(eq(apiTokens.tenantId, session.tenantId));
  if (existing.length >= MAX_TOKENS_PER_TENANT) {
    throw new TokenRefused(
      `A workspace can hold ${MAX_TOKENS_PER_TENANT} tokens; revoke one first.`,
    );
  }
  const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  const id = randomUUID();
  const expiresAt =
    input.expiresInDays === null
      ? null
      : new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000);
  await system.insert(apiTokens).values({
    id,
    tenantId: session.tenantId,
    createdBy: session.userId,
    name: input.name,
    tokenHash: hash(token),
    role: input.role,
    expiresAt,
  });
  return { id, token, expiresAt: expiresAt?.toISOString() ?? null };
}

export async function listApiTokens(tenantId: TenantId) {
  const rows = await system
    .select({
      id: apiTokens.id,
      name: apiTokens.name,
      role: apiTokens.role,
      createdAt: apiTokens.createdAt,
      lastUsedAt: apiTokens.lastUsedAt,
      expiresAt: apiTokens.expiresAt,
      createdBy: users.email,
    })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.createdBy))
    .where(eq(apiTokens.tenantId, tenantId))
    .orderBy(desc(apiTokens.createdAt));
  return rows.map((r) => ({
    ...r,
    createdAt: r.createdAt.toISOString(),
    lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
    expiresAt: r.expiresAt?.toISOString() ?? null,
  }));
}

/** Scoped to the tenant, so an id from elsewhere revokes nothing. */
export async function revokeApiToken(tenantId: TenantId, id: string): Promise<boolean> {
  const deleted = await system
    .delete(apiTokens)
    .where(and(eq(apiTokens.id, id), eq(apiTokens.tenantId, tenantId)))
    .returning({ id: apiTokens.id });
  return deleted.length > 0;
}

/** The session a bearer token stands for, or null if it is unknown or expired. */
export async function readApiToken(token: string): Promise<Session | null> {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const expected = hash(token);
  const [row] = await system
    .select({
      id: apiTokens.id,
      tokenHash: apiTokens.tokenHash,
      role: apiTokens.role,
      expiresAt: apiTokens.expiresAt,
      lastUsedAt: apiTokens.lastUsedAt,
      userId: users.id,
      userRole: users.role,
      email: users.email,
      tenantId: users.tenantId,
      tokenTenant: apiTokens.tenantId,
      isAdmin: tenants.isAdmin,
    })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.createdBy))
    .innerJoin(tenants, eq(tenants.id, apiTokens.tenantId))
    .where(eq(apiTokens.tokenHash, expected));
  if (!row) return null;
  if (row.tokenHash.length !== expected.length || !timingSafeEqual(row.tokenHash, expected)) {
    return null;
  }
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;
  // A creator who has since moved to another workspace no longer speaks for this one.
  if (row.tenantId !== row.tokenTenant) return null;
  if (!TEAM_ROLES.includes(row.role) || !TEAM_ROLES.includes(row.userRole)) return null;

  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 5 * 60 * 1000) {
    await system
      .update(apiTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiTokens.id, row.id))
      .catch(() => undefined);
  }

  return {
    id: row.id,
    userId: row.userId,
    tenantId: asTenantId(row.tokenTenant),
    email: row.email,
    isAdmin: row.isAdmin,
    role: lesser(row.role, row.userRole),
    // Not a session's expiry: nothing downstream renews a token.
    expiresAt: row.expiresAt ?? new Date(8.64e15),
    via: "token",
  };
}
