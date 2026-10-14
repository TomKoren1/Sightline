/**
 * The self-hosted deployment, expressed as one tenant that always exists.
 *
 * The alternative was an optional tenant, or a "single-tenant mode" that skips
 * scoping - both of which produce a codebase with two paths through every
 * query, one of them only ever exercised in production. Here there is no
 * unscoped path: a clone of this repository is a tenant with two connections,
 * and it runs the same code the hosted service does.
 *
 * The ids are fixed rather than generated, so the bootstrap is idempotent and
 * the CLIs can address a connection without first looking one up.
 */

import { and, eq, ne } from "drizzle-orm";

import { cfg, configuredMode, isHosted, targetRoleProblem } from "../config.js";
/**
 * `system`, not `db`: this creates the tenant everything else is scoped to.
 *
 * It runs on boot, before any request, and it inserts the local tenant row
 * itself - so there is no tenant context to be inside, and the thing it is
 * creating is the context. Self-hosted only; in hosted mode tenants arrive by
 * signing up.
 */
import { system } from "../db/postgres.js";
import { connections, tenants } from "../db/schema.js";
import { asConnectionId, asTenantId, type ConnectionId } from "./ids.js";
import type { Scope } from "./scope.js";

export const LOCAL_TENANT_ID = asTenantId("00000000-0000-0000-0000-000000000001");
export const LOCAL_DEMO_CONNECTION_ID = asConnectionId("00000000-0000-0000-0000-000000000002");
export const LOCAL_REAL_CONNECTION_ID = asConnectionId("00000000-0000-0000-0000-000000000003");

/** Is a real account configured well enough to be worth a connection row? */
export function realAccountConfigured(): boolean {
  return (
    cfg.AWS_TARGET_ROLE_ARN !== "arn:aws:iam::123456789012:role/SightlineReadOnlyRole" &&
    targetRoleProblem() === null
  );
}

/**
 * The connection a self-hosted process reads by default.
 *
 * Follows `AWS_MODE`, so a clone behaves exactly as it did: `mock` lands on the
 * demo fixture, `real` on the configured account. The difference is that this
 * is now a *selection* between two rows rather than a process-wide flag, which
 * is what lets the same code serve many tenants.
 */
export function localConnectionId(): ConnectionId {
  return configuredMode === "real" && realAccountConfigured()
    ? LOCAL_REAL_CONNECTION_ID
    : LOCAL_DEMO_CONNECTION_ID;
}

/**
 * The scope for a self-hosted process.
 *
 * Throws in hosted mode, where there is no such thing - the tenant must come
 * from the request. A hosted code path reaching for this has lost track of
 * whose data it is handling and should fail rather than guess.
 */
export function localScope(): Scope {
  if (isHosted()) {
    throw new Error(
      "There is no local tenant in hosted mode - the scope must come from the request",
    );
  }
  return { tenantId: LOCAL_TENANT_ID, connectionId: localConnectionId() };
}

/**
 * Create the local tenant and its connections if they are absent.
 *
 * Idempotent, and safe to run on every boot: `onConflictDoNothing` rather than
 * an upsert, because re-running must not overwrite a label someone edited or
 * reset a verified connection to pending.
 */
export async function ensureLocalTenant(): Promise<void> {
  if (isHosted()) return;

  await system
    .insert(tenants)
    .values({ id: LOCAL_TENANT_ID, name: "Local", isAdmin: true })
    .onConflictDoNothing();

  await system
    .insert(connections)
    .values({
      id: LOCAL_DEMO_CONNECTION_ID,
      tenantId: LOCAL_TENANT_ID,
      kind: "demo",
      label: "Demo account",
      externalIdSource: "demo",
      status: "verified",
      lastVerifiedAt: new Date(),
    })
    .onConflictDoNothing();

  if (!realAccountConfigured()) return;

  await system
    .insert(connections)
    .values({
      id: LOCAL_REAL_CONNECTION_ID,
      tenantId: LOCAL_TENANT_ID,
      kind: "real",
      label: "My AWS",
      roleArn: cfg.AWS_TARGET_ROLE_ARN,
      // `config`, not `stored`: the plaintext is already in `.env` on the same
      // disk, so encrypting a copy of it would protect nothing.
      externalIdSource: "config",
      status: "pending",
    })
    .onConflictDoNothing();

  /**
   * Keep the role ARN in step with `.env`, because editing it there is how a
   * self-hosted operator repoints the connection.
   *
   * A changed ARN also invalidates the previous verification and clears the
   * pinned account: the connection is unproven again until it is tested, and
   * leaving it "verified" against an account it no longer reaches is the
   * misleading state this column exists to avoid. Conditional, so a boot that
   * changed nothing writes nothing.
   */
  await system
    .update(connections)
    .set({
      roleArn: cfg.AWS_TARGET_ROLE_ARN,
      accountId: null,
      status: "pending",
      lastError: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(connections.id, LOCAL_REAL_CONNECTION_ID),
        ne(connections.roleArn, cfg.AWS_TARGET_ROLE_ARN),
      ),
    );
}
