/**
 * The team rules, against Postgres: an invite moves a new user in and is used
 * once, roles change only within what the actor may grant, a workspace always
 * keeps an owner, and leaving takes only the person who leaves.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";

import { system } from "../db/postgres.js";
import * as schema from "../db/schema.js";
import { asTenantId } from "../core/ids.js";
import type { TeamRole } from "../core/access.js";
import type { Session } from "../core/request.js";
import {
  acceptInvite,
  createInvite,
  leaveOrLast,
  listTeam,
  removeMember,
  revokeInvite,
  setRole,
} from "./team.js";

const HAS_INFRA = !process.env["SKIP_INTEGRATION"];
const tenants: string[] = [];
let available = false;

/** A user alone in a tenant of their own, as signing in makes one. */
async function newUser(name: string, role: TeamRole = "owner"): Promise<Session> {
  const tenantId = randomUUID();
  const userId = randomUUID();
  tenants.push(tenantId);
  await system.insert(schema.tenants).values({ id: tenantId, name });
  await system.insert(schema.users).values({
    id: userId,
    tenantId,
    email: `${name}-${userId.slice(0, 6)}@team.test`,
    role,
  });
  return {
    id: randomUUID(),
    userId,
    tenantId: asTenantId(tenantId),
    email: `${name}@team.test`,
    isAdmin: false,
    role,
    expiresAt: new Date(Date.now() + 3600_000),
  };
}

/** The session as the guard would read it now: their current tenant and role. */
async function refreshed(s: Session): Promise<Session> {
  const [row] = await system.select().from(schema.users).where(eq(schema.users.id, s.userId));
  return { ...s, tenantId: asTenantId(row!.tenantId), role: row!.role };
}

const tokenOf = (url: string) => new URL(url).searchParams.get("join")!;

beforeAll(async () => {
  if (!HAS_INFRA) return;
  try {
    await system.execute(sql`SELECT 1 FROM invites LIMIT 1`);
    available = true;
  } catch (err) {
    console.warn("team.test skipped:", err);
  }
});

afterAll(async () => {
  if (available && tenants.length > 0) {
    await system.delete(schema.tenants).where(inArray(schema.tenants.id, tenants));
  }
});

describe.runIf(HAS_INFRA)("teams", () => {
  it("moves an invited user in, deletes their empty tenant, and works only once", async () => {
    if (!available) return;
    const owner = await newUser("owner");
    const joiner = await newUser("joiner");
    const invite = await createInvite(owner, "member");

    const joined = await acceptInvite(joiner, tokenOf(invite.url));
    expect(joined).toEqual({ tenantId: owner.tenantId, role: "member" });
    const now = await refreshed(joiner);
    expect(now).toMatchObject({ tenantId: owner.tenantId, role: "member" });
    const [gone] = await system
      .select()
      .from(schema.tenants)
      .where(eq(schema.tenants.id, joiner.tenantId));
    expect(gone).toBeUndefined();

    const third = await newUser("third");
    await expect(acceptInvite(third, tokenOf(invite.url))).rejects.toThrow(/already been used/);
    expect((await listTeam(owner.tenantId)).members.map((m) => m.role)).toEqual([
      "owner",
      "member",
    ]);
  });

  it("refuses to abandon a workspace that has accounts in it", async () => {
    if (!available) return;
    const owner = await newUser("owner2");
    const busy = await newUser("busy");
    await system.insert(schema.connections).values({
      id: randomUUID(),
      tenantId: busy.tenantId,
      kind: "demo",
      label: "mine",
      externalIdSource: "demo",
    });
    const invite = await createInvite(owner, "viewer");
    await expect(acceptInvite(busy, tokenOf(invite.url))).rejects.toThrow(/abandon/);
  });

  it("does not accept a revoked invite, or one for owner", async () => {
    if (!available) return;
    const owner = await newUser("owner3");
    const invite = await createInvite(owner, "admin");
    expect(await revokeInvite(owner, invite.id)).toBe(true);
    await expect(acceptInvite(await newUser("late"), tokenOf(invite.url))).rejects.toThrow(
      /not valid/,
    );
    await expect(createInvite(owner, "owner")).rejects.toThrow(/make them an owner/);
  });

  it("keeps an owner, and lets only owners touch ownership", async () => {
    if (!available) return;
    const owner = await newUser("owner4");
    const joiner = await newUser("admin4");
    await acceptInvite(joiner, tokenOf((await createInvite(owner, "admin")).url));
    const admin = await refreshed(joiner);

    await expect(setRole(owner, owner.userId, "admin")).rejects.toThrow(/needs an owner/);
    await expect(setRole(admin, owner.userId, "viewer")).rejects.toThrow(/Only an owner/);
    await expect(setRole(admin, admin.userId, "owner")).rejects.toThrow(/Only an owner/);
    await expect(removeMember(admin, owner.userId)).rejects.toThrow(/Only an owner/);

    await setRole(owner, admin.userId, "owner");
    await setRole(owner, owner.userId, "member");
    const roles = (await listTeam(owner.tenantId)).members.map((m) => m.role);
    expect(roles.sort()).toEqual(["member", "owner"]);

    const audit = await system.execute<{ action: string }>(
      sql`SELECT action FROM audit_log WHERE tenant_id = ${owner.tenantId} ORDER BY created_at`,
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      "team.invited",
      "team.joined",
      "team.role_changed",
      "team.role_changed",
    ]);
  });

  it("leaving takes the person, not the workspace; the last owner cannot leave others behind", async () => {
    if (!available) return;
    const owner = await newUser("owner5");
    await acceptInvite(await newUser("m5"), tokenOf((await createInvite(owner, "member")).url));
    await expect(leaveOrLast(owner)).rejects.toThrow(/only owner/);

    const member = (await listTeam(owner.tenantId)).members.find((m) => m.role === "member")!;
    expect(await leaveOrLast({ ...owner, userId: member.id, role: "member" })).toBe("left");
    expect((await listTeam(owner.tenantId)).members).toHaveLength(1);
    expect(await leaveOrLast(owner)).toBe("last");
  });
});
