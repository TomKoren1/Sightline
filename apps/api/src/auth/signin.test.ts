/**
 * Signing in, as a journey through the database.
 *
 * The questions here are the ones that decide whether one person can end up
 * inside another's account, so they are asked against real rows rather than
 * against mocks: matching on subject and not email, what happens when the same
 * address arrives from a second provider, and whether a revoked session is
 * actually dead.
 *
 * Requires Postgres; skipped without it. Creates its own tenants and deletes
 * them afterwards, which cascades everything below.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";

import { db } from "../db/postgres.js";
import { identities, sessions, tenants, users } from "../db/schema.js";
import {
  findOrCreateUser,
  getUser,
  linkedProviders,
  SignInRefused,
  type SignedInUser,
} from "./users.js";
import {
  issueSession,
  listSessions,
  readSession,
  revokeAllSessions,
  revokeSession,
} from "./session.js";
import type { ExternalIdentity } from "./oauth.js";

const HAS_INFRA = !process.env["SKIP_INTEGRATION"];

/** Unique per run, so repeated runs and the unique email index do not collide. */
const run = randomUUID().slice(0, 8);

/**
 * An identity for one named case.
 *
 * `who` is scoped to this run, so repeated runs do not collide on the unique
 * email index and two cases in this file cannot be the same person.
 */
function identity(who: string, over: Partial<ExternalIdentity> = {}): ExternalIdentity {
  return {
    provider: "google",
    subject: `sub-${run}-${who}`,
    email: `signin-${run}-${who}@example.test`,
    emailVerified: true,
    name: "Test Person",
    avatarUrl: null,
    ...over,
  };
}

const created: string[] = [];
let available = false;

beforeAll(async () => {
  try {
    await db.execute("SELECT 1");
    available = true;
  } catch {
    console.warn("Sign-in suite skipped: Postgres was not reachable.");
  }
});

afterAll(async () => {
  if (!available || created.length === 0) return;
  await db
    .delete(tenants)
    .where(inArray(tenants.id, created))
    .catch(() => undefined);
});

async function signIn(id: ExternalIdentity): Promise<SignedInUser> {
  const user = await findOrCreateUser(id);
  if (!created.includes(user.tenantId)) created.push(user.tenantId);
  return user;
}

describe.runIf(HAS_INFRA)("a first sign-in", () => {
  it("creates a tenant and a user together", async () => {
    if (!available) return;
    const user = await signIn(identity("first"));

    expect(user.email).toBe(`signin-${run}-first@example.test`);
    // A tenant with no user is an orphan nobody can reach, and a user with no
    // tenant cannot be given one afterwards without guessing - so both or
    // neither.
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, user.tenantId));
    expect(tenant).toBeDefined();
    expect(await linkedProviders(user.id)).toEqual(["google"]);
  });

  it("never makes a new tenant an admin", async () => {
    if (!available) return;
    const user = await signIn(identity("notadmin"));
    // The flag is set by hand, in the database, for exactly one tenant. A
    // default of true here would hand every signup the demo account and the
    // reproject button.
    expect(user.isAdmin).toBe(false);
  });

  it("refuses an account with no verified address", async () => {
    if (!available) return;
    await expect(
      findOrCreateUser(identity("unverified", { emailVerified: false })),
    ).rejects.toThrow(SignInRefused);
    await expect(findOrCreateUser(identity("noemail", { email: null }))).rejects.toThrow(
      /verified email/,
    );
  });
});

describe.runIf(HAS_INFRA)("signing in again", () => {
  it("matches on the provider subject, not the address", async () => {
    if (!available) return;
    const first = await signIn(identity("stable"));

    /**
     * The same person, after changing their email at the provider.
     *
     * Subjects are stable; addresses are renamed and reassigned inside a
     * workspace. Matching on the address is how one person ends up inside
     * somebody else's account - so a changed address must still be the same
     * user, and must not create a second one.
     */
    const again = await findOrCreateUser({
      ...identity("stable"),
      email: `renamed-${run}@example.test`,
      name: "Renamed Person",
    });

    expect(again.id).toBe(first.id);
    expect(again.tenantId).toBe(first.tenantId);
    const rows = await db.select().from(users).where(eq(users.id, first.id));
    expect(rows).toHaveLength(1);
    // The display name is refreshed from the provider, because the UI should
    // show what they expect to see.
    expect(rows[0]!.name).toBe("Renamed Person");
  });

  it("refuses to join two providers on a matching address", async () => {
    if (!available) return;
    const first = await signIn(identity("shared"));

    /**
     * The same address arriving from GitHub.
     *
     * Most products link these silently. It is also how one person ends up
     * inside another's account when a provider's "verified" turns out to be
     * weaker than it looks - so it is refused, with a message saying what to do
     * instead.
     */
    await expect(
      findOrCreateUser({
        provider: "github",
        subject: `gh-${run}-shared`,
        email: first.email,
        emailVerified: true,
        name: null,
        avatarUrl: null,
      }),
    ).rejects.toThrow(/different sign-in provider/);

    // And nothing was half-created by the attempt.
    expect(await linkedProviders(first.id)).toEqual(["google"]);
  });
});

describe.runIf(HAS_INFRA)("sessions", () => {
  it("round-trips, and carries the tenant", async () => {
    if (!available) return;
    const user = await signIn(identity("session"));
    const token = await issueSession(user.id, { userAgent: "vitest", ip: "127.0.0.1" });

    const session = await readSession(token);
    expect(session?.userId).toBe(user.id);
    expect(session?.tenantId).toBe(user.tenantId);
    expect(session?.isAdmin).toBe(false);
  });

  it("stores only a hash, so the table is not a set of usable sessions", async () => {
    if (!available) return;
    const user = await signIn(identity("hashed"));
    const token = await issueSession(user.id);

    const rows = await db.select().from(sessions).where(eq(sessions.userId, user.id));
    expect(rows).toHaveLength(1);
    const stored = rows[0]!.tokenHash.toString("utf8");
    expect(stored).not.toContain(token);
    // 32 bytes of SHA-256, not a copy of the token in another encoding.
    expect(rows[0]!.tokenHash).toHaveLength(32);
  });

  it("refuses anything that is not a live token, without saying which", async () => {
    if (!available) return;
    for (const bad of [undefined, "", "not-a-token", randomUUID()]) {
      expect(await readSession(bad)).toBeNull();
    }
  });

  it("is dead once revoked", async () => {
    if (!available) return;
    const user = await signIn(identity("revoked"));
    const token = await issueSession(user.id);
    expect(await readSession(token)).not.toBeNull();

    await revokeSession(token);
    // The whole reason sessions are a table rather than a signed cookie.
    expect(await readSession(token)).toBeNull();
  });

  it("signs out everywhere", async () => {
    if (!available) return;
    const user = await signIn(identity("everywhere"));
    const tokens = await Promise.all([
      issueSession(user.id, { userAgent: "laptop" }),
      issueSession(user.id, { userAgent: "phone" }),
      issueSession(user.id, { userAgent: "tablet" }),
    ]);

    const listed = await listSessions(user.id, tokens[0]);
    expect(listed).toHaveLength(3);
    // Exactly one is marked as the one asking, so the UI can say "this device".
    expect(listed.filter((s) => s.current)).toHaveLength(1);

    expect(await revokeAllSessions(user.id)).toBe(3);
    for (const token of tokens) expect(await readSession(token)).toBeNull();
  });

  it("refuses an expired session even though the row is still there", async () => {
    if (!available) return;
    const user = await signIn(identity("expired"));
    const token = await issueSession(user.id);
    await db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.userId, user.id));

    expect(await readSession(token)).toBeNull();
  });

  it("goes with the user when the user goes", async () => {
    if (!available) return;
    const user = await signIn(identity("cascade"));
    const token = await issueSession(user.id);
    await db.delete(users).where(eq(users.id, user.id));

    // Cascade, not cleanup code: a deleted account must not leave a live
    // session behind, and a foreign key is the only version of that which
    // cannot be forgotten.
    expect(await readSession(token)).toBeNull();
    expect(await getUser(user.id)).toBeNull();
    expect(await db.select().from(identities).where(eq(identities.userId, user.id))).toHaveLength(
      0,
    );
  });
});
