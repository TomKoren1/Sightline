/**
 * Who belongs to a tenant, and how they got there.
 *
 * Joining is by a link an admin copies to the person: no email is sent, so
 * nothing to pay for or configure. A new user signs in, which makes them an
 * empty tenant as always, and accepting moves them into the inviting one and
 * deletes the empty one. A user whose tenant holds accounts or other people is
 * refused rather than having it orphaned. On `system`, like the rest of
 * `auth/`: an invite is found by token before the joiner's tenant is known.
 */

import type * as api from "@sightline/shared/api";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { cfg } from "../core/config.js";
import { system } from "../db/postgres.js";
import type { TenantId } from "../core/ids.js";
import { atLeast, type TeamRole } from "../core/access.js";
import type { Session } from "../core/request.js";

/** A request the rules refuse; its message is for the person who made it. */
export class TeamRefused extends Error {}

const INVITE_DAYS = 7;
const hash = (token: string) => createHash("sha256").update(token).digest();

type Tx = Parameters<Parameters<typeof system.transaction>[0]>[0];

async function audit(
  tx: Tx,
  tenantId: TenantId | string,
  actor: string | null,
  action: string,
  subject: string | null,
  detail: Record<string, unknown> = {},
) {
  await tx.execute(sql`
    INSERT INTO audit_log (id, tenant_id, actor_user_id, action, subject, detail)
    VALUES (${randomUUID()}, ${tenantId}, ${actor}, ${action}, ${subject},
            ${JSON.stringify(detail)}::jsonb)`);
}

/** The team as the API returns it, less `you`, which the controller adds. */
export type TeamView = Omit<api.Team, "you">;

export async function listTeam(tenantId: TenantId): Promise<TeamView> {
  const members = await system.execute<{
    id: string;
    email: string;
    name: string | null;
    role: TeamRole;
    created_at: Date;
    last_seen_at: Date | null;
  }>(sql`
    SELECT id, email, name, role, created_at, last_seen_at FROM users
     WHERE tenant_id = ${tenantId}
     ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END, email`);
  const invites = await system.execute<{
    id: string;
    role: TeamRole;
    created_at: Date;
    expires_at: Date;
    created_by: string | null;
  }>(sql`
    SELECT i.id, i.role, i.created_at, i.expires_at, u.email AS created_by
      FROM invites i LEFT JOIN users u ON u.id = i.created_by
     WHERE i.tenant_id = ${tenantId} AND i.accepted_at IS NULL AND i.revoked_at IS NULL
       AND i.expires_at > now()
     ORDER BY i.created_at DESC`);
  return {
    members: members.rows.map((m) => ({
      id: m.id,
      email: m.email,
      name: m.name,
      role: m.role,
      joinedAt: new Date(m.created_at).toISOString(),
      lastSeenAt: m.last_seen_at ? new Date(m.last_seen_at).toISOString() : null,
    })),
    invites: invites.rows.map((i) => ({
      id: i.id,
      role: i.role,
      createdAt: new Date(i.created_at).toISOString(),
      expiresAt: new Date(i.expires_at).toISOString(),
      createdBy: i.created_by,
    })),
  };
}

/** A single-use link, valid for a week. The token is returned once and kept only as a hash. */
export async function createInvite(session: Session, role: TeamRole) {
  if (role === "owner") {
    throw new TeamRefused(
      "Invite them as an admin, then make them an owner once they have joined.",
    );
  }
  const token = randomBytes(32).toString("base64url");
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + INVITE_DAYS * 86_400_000);
  await system.transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO invites (id, tenant_id, token_hash, role, created_by, expires_at)
      VALUES (${id}, ${session.tenantId}, ${hash(token)}, ${role}, ${session.userId}, ${expiresAt})`);
    await audit(tx, session.tenantId, session.userId, "team.invited", id, { role });
  });
  const base = cfg.PUBLIC_BASE_URL.replace(/\/$/, "");
  return { id, role, expiresAt: expiresAt.toISOString(), url: `${base}/?join=${token}` };
}

export async function revokeInvite(session: Session, inviteId: string): Promise<boolean> {
  return system.transaction(async (tx) => {
    const { rows } = await tx.execute(sql`
      UPDATE invites SET revoked_at = now()
       WHERE id = ${inviteId} AND tenant_id = ${session.tenantId}
         AND accepted_at IS NULL AND revoked_at IS NULL
      RETURNING id`);
    if (rows.length === 0) return false;
    await audit(tx, session.tenantId, session.userId, "team.invite_revoked", inviteId);
    return true;
  });
}

/** Join the tenant an invite is for. Returns the tenant joined. */
export async function acceptInvite(
  session: Session,
  token: string,
): Promise<{ tenantId: string; role: TeamRole }> {
  return system.transaction(async (tx) => {
    const { rows } = await tx.execute<{
      id: string;
      tenant_id: string;
      role: TeamRole;
      expires_at: Date;
      accepted_at: Date | null;
      revoked_at: Date | null;
    }>(sql`
      SELECT id, tenant_id, role, expires_at, accepted_at, revoked_at FROM invites
       WHERE token_hash = ${hash(token)} FOR UPDATE`);
    const invite = rows[0];
    if (!invite || invite.revoked_at)
      throw new TeamRefused("That invite link is not valid. Ask for a new one.");
    if (invite.accepted_at)
      throw new TeamRefused("That invite link has already been used. Ask for a new one.");
    if (new Date(invite.expires_at).getTime() <= Date.now()) {
      throw new TeamRefused("That invite link has expired. Ask for a new one.");
    }
    if (invite.tenant_id === session.tenantId) {
      throw new TeamRefused("You are already a member of this workspace.");
    }

    // The workspace they are leaving must have nothing in it to lose.
    const { rows: held } = await tx.execute<{ members: number; connections: number }>(sql`
      SELECT (SELECT count(*)::int FROM users WHERE tenant_id = ${session.tenantId}) AS members,
             (SELECT count(*)::int FROM connections WHERE tenant_id = ${session.tenantId}) AS connections`);
    const { members = 0, connections = 0 } = held[0] ?? {};
    if (members > 1 || connections > 0) {
      throw new TeamRefused(
        "Your own workspace has connected accounts or other members, so joining would abandon " +
          "them. Disconnect its accounts and remove its members first, or sign in with another account.",
      );
    }

    const previous = session.tenantId;
    await tx.execute(sql`
      UPDATE users SET tenant_id = ${invite.tenant_id}, role = ${invite.role}
       WHERE id = ${session.userId}`);
    await tx.execute(sql`
      UPDATE invites SET accepted_at = now(), accepted_by = ${session.userId} WHERE id = ${invite.id}`);
    // Empty, as just checked: its audit trail and settings go with it.
    await tx.execute(sql`DELETE FROM tenants WHERE id = ${previous}`);
    await audit(tx, invite.tenant_id, session.userId, "team.joined", session.userId, {
      role: invite.role,
      invite: invite.id,
    });
    return { tenantId: invite.tenant_id, role: invite.role };
  });
}

/** Lock the tenant's members, for a decision about how many owners remain. */
async function membersOf(tx: Tx, tenantId: string) {
  const { rows } = await tx.execute<{ id: string; role: TeamRole; email: string }>(sql`
    SELECT id, role, email FROM users WHERE tenant_id = ${tenantId} ORDER BY id FOR UPDATE`);
  return rows;
}

export async function setRole(session: Session, userId: string, role: TeamRole): Promise<void> {
  await system.transaction(async (tx) => {
    const members = await membersOf(tx, session.tenantId);
    const target = members.find((m) => m.id === userId);
    if (!target) throw new TeamRefused("No such member of this workspace.");
    if ((role === "owner" || target.role === "owner") && session.role !== "owner") {
      throw new TeamRefused("Only an owner can make someone an owner, or change an owner's role.");
    }
    if (!atLeast(session.role, "admin"))
      throw new TeamRefused("Changing roles needs the admin role.");
    const owners = members.filter((m) => m.role === "owner").length;
    if (target.role === "owner" && role !== "owner" && owners === 1) {
      throw new TeamRefused("A workspace needs an owner. Make someone else an owner first.");
    }
    if (target.role === role) return;
    await tx.execute(sql`UPDATE users SET role = ${role} WHERE id = ${userId}`);
    await audit(tx, session.tenantId, session.userId, "team.role_changed", userId, {
      email: target.email,
      from: target.role,
      to: role,
    });
  });
}

export async function removeMember(session: Session, userId: string): Promise<void> {
  if (userId === session.userId) {
    throw new TeamRefused("To leave the workspace yourself, delete your account.");
  }
  await system.transaction(async (tx) => {
    const target = (await membersOf(tx, session.tenantId)).find((m) => m.id === userId);
    if (!target) throw new TeamRefused("No such member of this workspace.");
    if (target.role === "owner" && session.role !== "owner") {
      throw new TeamRefused("Only an owner can remove an owner.");
    }
    // Their sessions and sign-in identities go with the row.
    await tx.execute(sql`DELETE FROM users WHERE id = ${userId}`);
    await audit(tx, session.tenantId, session.userId, "team.removed", userId, {
      email: target.email,
      role: target.role,
    });
  });
}

/**
 * What deleting your account means: leaving, when others remain - refused for
 * the last owner - or the whole workspace, when you are the only one in it.
 */
export async function leaveOrLast(session: Session): Promise<"left" | "last"> {
  return system.transaction(async (tx) => {
    const members = await membersOf(tx, session.tenantId);
    if (members.length <= 1) return "last";
    const owners = members.filter((m) => m.role === "owner").length;
    if (session.role === "owner" && owners === 1) {
      throw new TeamRefused(
        "You are this workspace's only owner. Make someone else an owner before you leave, " +
          "or remove the other members to delete the workspace with your account.",
      );
    }
    await tx.execute(sql`DELETE FROM users WHERE id = ${session.userId}`);
    await audit(tx, session.tenantId, null, "team.left", session.userId, { email: session.email });
    return "left";
  });
}
