/**
 * Users, and the tenant each one belongs to.
 *
 * Signing in for the first time creates **both**: a tenant, and a user in it.
 * That is the whole signup path - there is no "create an organisation" step,
 * because a tenant with one member is what every account starts as, and
 * inventing the ceremony before anyone has asked for teams would be building
 * for an imagined user. `users.tenant_id` exists from the start even so,
 * because adding a second member later is then a row, while retrofitting
 * tenancy onto a `user_id`-keyed schema is a migration nobody enjoys.
 *
 * Matching is on the provider **subject**, never on the email address. Subjects
 * are stable; email addresses are renamed, reassigned inside a workspace, and -
 * when unverified - not evidence of anything. Matching on email is how one
 * person ends up inside somebody else's account.
 */

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

import { db } from "../db/postgres.js";
import { identities, tenants, users } from "../db/schema.js";
import { asTenantId, type TenantId } from "../tenancy/ids.js";
import type { ExternalIdentity } from "./oauth.js";

export interface SignedInUser {
  id: string;
  tenantId: TenantId;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  isAdmin: boolean;
}

/** Why a sign-in was refused, in words the UI can show as-is. */
export class SignInRefused extends Error {}

/**
 * The user behind an identity, creating them and their tenant if new.
 *
 * One transaction throughout: a tenant with no user in it is an orphan nobody
 * can reach, and a user with no tenant cannot be given one afterwards without
 * guessing.
 */
export async function findOrCreateUser(identity: ExternalIdentity): Promise<SignedInUser> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({
        id: users.id,
        tenantId: users.tenantId,
        email: users.email,
        name: users.name,
        avatarUrl: users.avatarUrl,
        isAdmin: tenants.isAdmin,
      })
      .from(identities)
      .innerJoin(users, eq(users.id, identities.userId))
      .innerJoin(tenants, eq(tenants.id, users.tenantId))
      .where(
        and(eq(identities.provider, identity.provider), eq(identities.subject, identity.subject)),
      );

    if (existing) {
      // The display details can change on the provider's side; the subject
      // cannot. Keep ours current so the UI shows what they expect to see.
      await tx
        .update(users)
        .set({
          lastSeenAt: new Date(),
          ...(identity.name ? { name: identity.name } : {}),
          ...(identity.avatarUrl ? { avatarUrl: identity.avatarUrl } : {}),
        })
        .where(eq(users.id, existing.id));
      return { ...existing, tenantId: asTenantId(existing.tenantId) };
    }

    /**
     * A first sign-in needs an address, because `users.email` is unique and is
     * how a person recognises their own account.
     *
     * Unverified is refused rather than stored: on GitHub anyone can add any
     * address to their account, and only confirming it marks it verified. An
     * unverified address would let somebody claim the `users.email` slot
     * belonging to a person who has not signed up yet.
     */
    if (!identity.email || !identity.emailVerified) {
      throw new SignInRefused(
        `Your ${identity.provider} account has no verified email address. Verify one with ` +
          `${identity.provider} and try again — Sightline uses it to identify your account.`,
      );
    }

    /**
     * The same address on a different provider is **not** silently linked.
     *
     * Linking on a matching email is what most products do and it is how one
     * person ends up inside another's account when a provider's "verified" is
     * weaker than it looks. Refused with an explanation instead; deliberate
     * linking from a settings screen is the safe version of this, and it is not
     * built yet.
     */
    const [clash] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, identity.email));
    if (clash) {
      throw new SignInRefused(
        `An account already exists for ${identity.email}, created with a different sign-in ` +
          "provider. Sign in with the provider you used originally — Sightline will not join " +
          "two accounts together on a matching email address.",
      );
    }

    const tenantId = randomUUID();
    const userId = randomUUID();

    await tx.insert(tenants).values({ id: tenantId, name: identity.email });
    await tx.insert(users).values({
      id: userId,
      tenantId,
      email: identity.email,
      name: identity.name,
      avatarUrl: identity.avatarUrl,
      lastSeenAt: new Date(),
    });
    await tx
      .insert(identities)
      .values({ provider: identity.provider, subject: identity.subject, userId });

    return {
      id: userId,
      tenantId: asTenantId(tenantId),
      email: identity.email,
      name: identity.name,
      avatarUrl: identity.avatarUrl,
      // A new tenant is never an admin. The flag is set by hand, in the
      // database, for exactly one tenant.
      isAdmin: false,
    };
  });
}

/** The signed-in user, for `/api/me`. */
export async function getUser(userId: string): Promise<SignedInUser | null> {
  const [row] = await db
    .select({
      id: users.id,
      tenantId: users.tenantId,
      email: users.email,
      name: users.name,
      avatarUrl: users.avatarUrl,
      isAdmin: tenants.isAdmin,
    })
    .from(users)
    .innerJoin(tenants, eq(tenants.id, users.tenantId))
    .where(eq(users.id, userId));
  return row ? { ...row, tenantId: asTenantId(row.tenantId) } : null;
}

/** Which providers this user has linked, so the UI can say so. */
export async function linkedProviders(userId: string): Promise<string[]> {
  const rows = await db
    .select({ provider: identities.provider })
    .from(identities)
    .where(eq(identities.userId, userId));
  return rows.map((r) => r.provider);
}
