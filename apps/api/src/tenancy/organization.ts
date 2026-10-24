/**
 * An AWS Organization as one connection that finds its own accounts.
 *
 * The organization connection holds a role in the management account (or a
 * delegated administrator), which may call `organizations:ListAccounts`. Each
 * active member becomes a child connection: an ordinary account connection,
 * scanned, pinned and isolated exactly as one added by hand, whose role is the
 * one the customer's StackSet deployed to every account under the same name
 * and ExternalId. So the child carries a copy of the organization's encrypted
 * ExternalId rather than a new one, and is deleted with the organization.
 */

import { randomUUID } from "node:crypto";
import { paginateListAccounts } from "@aws-sdk/client-organizations";
import { and, eq } from "drizzle-orm";
import { readOnlyRoleArn } from "@sightline/shared";

import { CallCounter, organizationsClient } from "../aws/clients.js";
import { db, withTenant } from "../db/postgres.js";
import { connections } from "../db/schema.js";
import { asConnectionId, type ConnectionId } from "../core/ids.js";
import type { ScanTarget } from "../core/scanTarget.js";
import type { Scope } from "../core/scope.js";

export interface MemberAccount {
  id: string;
  name: string | null;
  /** ACTIVE, SUSPENDED, PENDING_CLOSURE, CLOSED - AWS's own words. */
  state: string | null;
}

/** Every account the organization role can see. */
export async function listMemberAccounts(target: ScanTarget): Promise<MemberAccount[]> {
  const client = organizationsClient({ target, counter: new CallCounter() });
  const accounts: MemberAccount[] = [];
  for await (const page of paginateListAccounts({ client }, {})) {
    for (const a of page.Accounts ?? []) {
      if (!a.Id) continue;
      accounts.push({ id: a.Id, name: a.Name ?? null, state: a.State ?? a.Status ?? null });
    }
  }
  return accounts;
}

export interface MemberSync {
  /** Children to verify: new ones, and ones not yet verified. */
  pending: { id: ConnectionId; label: string }[];
  added: number;
  /** Members already connected by hand, which are left as they are. */
  alreadyConnected: string[];
  /** Children whose account is no longer an active member. */
  departed: number;
}

/** One child per active member; the rest are marked disconnected, not deleted. */
export async function syncMembers(org: Scope, accounts: MemberAccount[]): Promise<MemberSync> {
  return withTenant(org.tenantId, async () => {
    const [parent] = await db
      .select({ blob: connections.externalIdEncrypted })
      .from(connections)
      .where(and(eq(connections.id, org.connectionId), eq(connections.tenantId, org.tenantId)));
    if (!parent?.blob) throw new Error("The organization connection holds no ExternalId");

    const all = await db
      .select({
        id: connections.id,
        parentId: connections.parentId,
        roleArn: connections.roleArn,
        status: connections.status,
        label: connections.label,
      })
      .from(connections)
      .where(eq(connections.tenantId, org.tenantId));
    const children = all.filter((c) => c.parentId === org.connectionId);
    const byRole = new Map(children.map((c) => [c.roleArn, c]));
    const standalone = new Set(all.filter((c) => c.parentId === null).map((c) => c.roleArn));

    const active = accounts.filter((a) => a.state === "ACTIVE");
    const sync: MemberSync = { pending: [], added: 0, alreadyConnected: [], departed: 0 };
    const wanted = new Set<string>();

    for (const account of active) {
      const roleArn = readOnlyRoleArn(account.id, org.tenantId);
      wanted.add(roleArn);
      const label = account.name ?? account.id;
      const existing = byRole.get(roleArn);
      if (existing) {
        if (existing.status === "disconnected" || existing.label !== label) {
          await db
            .update(connections)
            .set({
              label,
              ...(existing.status === "disconnected" ? { status: "pending", lastError: null } : {}),
              updatedAt: new Date(),
            })
            .where(eq(connections.id, existing.id));
        }
        if (existing.status !== "verified") {
          sync.pending.push({ id: asConnectionId(existing.id), label });
        }
        continue;
      }
      if (standalone.has(roleArn)) {
        sync.alreadyConnected.push(account.id);
        continue;
      }
      const id = asConnectionId(randomUUID());
      await db.insert(connections).values({
        id,
        tenantId: org.tenantId,
        kind: "real",
        parentId: org.connectionId,
        label,
        roleArn,
        externalIdSource: "stored",
        externalIdEncrypted: parent.blob,
        status: "pending",
      });
      sync.added++;
      sync.pending.push({ id, label });
    }

    for (const child of children) {
      if ((child.roleArn && wanted.has(child.roleArn)) || child.status === "disconnected") continue;
      await db
        .update(connections)
        .set({
          status: "disconnected",
          lastError: "No longer an active member of the organization.",
          updatedAt: new Date(),
        })
        .where(eq(connections.id, child.id));
      sync.departed++;
    }
    return sync;
  });
}
