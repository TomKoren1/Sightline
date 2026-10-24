/**
 * Deleting an account, and everything Sightline holds about it.
 *
 * One cascading delete from the tenant row: every table holding this tenant's
 * data, the scan snapshots that are the graph included, references it.
 *
 * It cannot delete the CloudFormation stack in the customer's account. Only
 * they can, and the response says so: telling somebody their access was
 * withdrawn while a role still trusts us is the worst thing to be wrong about.
 */

import { eq, inArray } from "drizzle-orm";

import { system } from "../db/postgres.js";
import {
  connections,
  conversations,
  messages,
  scanRuns,
  sessions,
  tenants,
  users,
} from "../db/schema.js";
import type { TenantId } from "../core/ids.js";

export interface PurgeResult {
  /** Counted before the delete, because afterwards there is nothing to count. */
  connections: number;
  scans: number;
  conversations: number;
  messages: number;
  users: number;
  sessions: number;
}

/**
 * Delete a tenant and everything belonging to it.
 *
 * Runs on `system`, which is one of the few places that is correct: the work
 * spans the tenant's own tables *and* the auth tables that carry no row-level
 * security policy, and the last statement deletes the very row the tenant
 * context is named after. A scoped connection could not do the second half.
 */
export async function purgeTenant(tenantId: TenantId): Promise<PurgeResult> {
  /**
   * Counted first, and from the database rather than from the delete's own
   * `rowCount`. The cascade does most of the deleting, so the counts the
   * statements report would describe only the tenant row - one row, which
   * tells the customer nothing about what was removed.
   */
  const userIds = (
    await system.select({ id: users.id }).from(users).where(eq(users.tenantId, tenantId))
  ).map((r) => r.id);

  const counts = {
    connections: await count(connections, tenantId),
    scans: await count(scanRuns, tenantId),
    conversations: await count(conversations, tenantId),
    messages: await count(messages, tenantId),
    users: userIds.length,
    sessions:
      userIds.length === 0
        ? 0
        : (
            await system
              .select({ id: sessions.id })
              .from(sessions)
              .where(inArray(sessions.userId, userIds))
          ).length,
  };

  /**
   * One statement. Every table that holds this tenant's data references
   * `tenants.id` with `ON DELETE CASCADE`, directly or through `users`, so this
   * is the whole deletion - and a cascade cannot leave half of it behind the
   * way a sequence of deletes in the wrong order can.
   *
   * `audit_log` cascades too, so the tenant's own audit trail goes with it.
   * That is the right answer for a deletion request: keeping a record of what
   * somebody did, after they have asked to be forgotten, is the thing they
   * asked not to happen. The *fact* of the deletion is logged by the caller,
   * with counts and no content.
   */
  await system.delete(tenants).where(eq(tenants.id, tenantId));

  return counts;
}

/** How many of this tenant's rows a table holds. */
async function count(
  table: typeof connections | typeof scanRuns | typeof conversations | typeof messages,
  tenantId: TenantId,
): Promise<number> {
  const rows = await system
    .select({ id: table.id })
    .from(table)
    .where(eq(table.tenantId, tenantId));
  return rows.length;
}

/**
 * What a customer must type to confirm.
 *
 * Their own email address, which is the pattern worth copying from the services
 * that get this right: it cannot be clicked through, it cannot be done by a
 * cross-site request that does not know it, and it makes the dialog impossible
 * to misread. A checkbox would be dismissed; "DELETE" would be muscle memory.
 */
export function confirmationMatches(email: string, typed: unknown): boolean {
  return typeof typed === "string" && typed.trim().toLowerCase() === email.trim().toLowerCase();
}
