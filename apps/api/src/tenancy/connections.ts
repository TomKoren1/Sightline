/**
 * A tenant's connected AWS accounts.
 *
 * Several per tenant, which is the difference from every earlier version of
 * this: the account is a row, not configuration. A tenant with no connection
 * gets an explicit refusal rather than falling back to whatever the process
 * was configured with - a fallback is indistinguishable from working, and
 * whoever configured the environment would see their own account and conclude
 * the product was fine while a customer read somebody else's inventory.
 *
 * The **account id is pinned on first verification** rather than read from the
 * role ARN at scan time, so a role ARN edited later cannot quietly repoint an
 * existing connection, its history and its graph at a different account.
 */

import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { readOnlyRoleArn } from "@sightline/shared";

import { cfg, MOCK_EXTERNAL_ID } from "../core/config.js";
import { db, withTenant } from "../db/postgres.js";
import { connections } from "../db/schema.js";
import { asConnectionId, type ConnectionId, type TenantId } from "../core/ids.js";
import { encryptSecret, decryptSecret, generateExternalId, isLegacySecret } from "./secrets.js";
import type { Scope } from "../core/scope.js";

export type ConnectionKind = "real" | "demo" | "organization";
export type ConnectionStatus = "pending" | "verified" | "failed" | "disconnected";

/** What the UI is allowed to see. Deliberately carries no secret. */
export interface ConnectionSummary {
  id: ConnectionId;
  kind: ConnectionKind;
  label: string;
  accountId: string | null;
  roleArn: string | null;
  status: ConnectionStatus;
  lastError: string | null;
  scanRegions: string[];
  templateVersion: string | null;
  lastVerifiedAt: string | null;
  lastScanAt: string | null;
  /** The organization connection that found this account, if one did. */
  parentId: ConnectionId | null;
}

type Row = typeof connections.$inferSelect;

const summarise = (row: Row): ConnectionSummary => ({
  id: row.id as ConnectionId,
  kind: row.kind,
  label: row.label,
  accountId: row.accountId,
  roleArn: row.roleArn,
  status: row.status,
  lastError: row.lastError,
  scanRegions: row.scanRegions,
  templateVersion: row.templateVersion,
  lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
  lastScanAt: row.lastScanAt?.toISOString() ?? null,
  parentId: (row.parentId as ConnectionId | null) ?? null,
});

const owned = (scope: Scope) =>
  and(eq(connections.id, scope.connectionId), eq(connections.tenantId, scope.tenantId));

export async function listConnections(tenantId: TenantId): Promise<ConnectionSummary[]> {
  return withTenant(tenantId, async () => {
    const rows = await db
      .select()
      .from(connections)
      .where(eq(connections.tenantId, tenantId))
      .orderBy(asc(connections.createdAt));
    return rows.map(summarise);
  });
}

export async function getConnection(scope: Scope): Promise<ConnectionSummary | null> {
  return withTenant(scope.tenantId, async () => {
    const [row] = await db.select().from(connections).where(owned(scope));
    return row ? summarise(row) : null;
  });
}

/** Decrypts, and rewrites a superseded envelope so old rows upgrade as they are used. */
async function reencryptIfLegacy(scope: Scope, blob: Buffer): Promise<string> {
  const externalId = await decryptSecret(blob);
  if (isLegacySecret(blob)) {
    await db
      .update(connections)
      .set({ externalIdEncrypted: await encryptSecret(externalId) })
      .where(owned(scope));
  }
  return externalId;
}

/**
 * The external id, decrypted.
 *
 * Separate from `getConnection` on purpose: rendering connection state never
 * needs the secret, and a function that returns it by default is one that will
 * eventually return it into a response body. Callers have to ask.
 */
export async function externalIdFor(scope: Scope): Promise<string> {
  return withTenant(scope.tenantId, async () => {
    const [row] = await db
      .select({
        source: connections.externalIdSource,
        blob: connections.externalIdEncrypted,
      })
      .from(connections)
      .where(owned(scope));
    if (!row) throw new Error("No such connection");

    switch (row.source) {
      case "stored":
        if (!row.blob) throw new Error("Connection claims a stored external id but holds none");
        return reencryptIfLegacy(scope, row.blob);
      case "config":
        return cfg.AWS_EXTERNAL_ID;
      case "demo":
        return MOCK_EXTERNAL_ID;
    }
  });
}

/**
 * Create a connection, issuing its external id now.
 *
 * Issued at creation rather than when a role ARN is saved, because the
 * customer needs this value *before* a role exists - it goes into the
 * CloudFormation stack that creates one. Generating a fresh id at save time
 * left the deployed stack and this service holding different secrets, which
 * surfaces as AccessDenied with both ends looking correct.
 *
 * Returns the plaintext once. It is never returned again.
 */
export async function createConnection(
  tenantId: TenantId,
  params: { kind: ConnectionKind; label: string; createdBy?: string | undefined },
): Promise<{ id: ConnectionId; externalId: string }> {
  return withTenant(tenantId, async () => {
    const id = asConnectionId(randomUUID());

    if (params.kind === "demo") {
      await db.insert(connections).values({
        id,
        tenantId,
        kind: "demo",
        label: params.label,
        externalIdSource: "demo",
        status: "verified",
        lastVerifiedAt: new Date(),
        ...(params.createdBy ? { createdBy: params.createdBy } : {}),
      });
      return { id, externalId: MOCK_EXTERNAL_ID };
    }

    const externalId = generateExternalId();
    await db.insert(connections).values({
      id,
      tenantId,
      // An organization holds an ExternalId like an account does: its StackSet
      // deploys that one value to every member.
      kind: params.kind,
      label: params.label,
      externalIdSource: "stored",
      externalIdEncrypted: await encryptSecret(externalId),
      status: "pending",
      ...(params.createdBy ? { createdBy: params.createdBy } : {}),
    });
    return { id, externalId };
  });
}

/**
 * Point a pending connection at an account.
 *
 * Only the twelve digits are asked for; the role ARN is derived from them and
 * from the tenant, because the role's name is the one this tenant's own
 * quick-create link deploys. One field is the whole difference between an
 * onboarding flow people finish and one they abandon, and a hand-pasted ARN is
 * the step where they mistype.
 *
 * Per-tenant, so two tenants may connect the same AWS account: one role of a
 * given name holds one trust policy and therefore one ExternalId, so a shared
 * name meant the second tenant to deploy owned the role and the first was
 * refused for ever.
 */
export async function setTargetAccount(
  scope: Scope,
  params: { accountId: string; templateVersion?: string | undefined },
): Promise<void> {
  return withTenant(scope.tenantId, async () => {
    if (!/^\d{12}$/.test(params.accountId)) {
      throw new Error("An AWS account id is twelve digits");
    }
    await db
      .update(connections)
      .set({
        roleArn: readOnlyRoleArn(params.accountId, scope.tenantId),
        // Deliberately *not* set as `accountId`: that column is what the role
        // actually reached, written only once an assume-role has proved it. A
        // typed-in value is a claim, not evidence.
        status: "pending",
        lastError: null,
        ...(params.templateVersion ? { templateVersion: params.templateVersion } : {}),
        updatedAt: new Date(),
      })
      .where(owned(scope));
  });
}

/** Record a successful assume-role, pinning the account it reached. */
export async function markVerified(scope: Scope, accountId: string): Promise<void> {
  return withTenant(scope.tenantId, async () => {
    await db
      .update(connections)
      .set({
        status: "verified",
        accountId,
        lastVerifiedAt: new Date(),
        lastError: null,
        updatedAt: new Date(),
      })
      .where(owned(scope));
  });
}

export async function markFailed(scope: Scope, error: string): Promise<void> {
  return withTenant(scope.tenantId, async () => {
    await db
      .update(connections)
      .set({ status: "failed", lastError: error, updatedAt: new Date() })
      .where(owned(scope));
  });
}

export async function markScanned(scope: Scope): Promise<void> {
  return withTenant(scope.tenantId, async () => {
    await db.update(connections).set({ lastScanAt: new Date() }).where(owned(scope));
  });
}

/**
 * Forget everything about a connection.
 *
 * Postgres cascades from the `connections` row, so the scans, units, snapshots
 * - which are the graph - and conversations all go with it in one statement.
 *
 * Deliberately does **not** claim the customer is disconnected at the AWS end -
 * only they can delete the CloudFormation stack that trusts us, and saying
 * otherwise would leave standing access nobody believed was there.
 */
export async function deleteConnection(scope: Scope): Promise<void> {
  return withTenant(scope.tenantId, async () => {
    await db.delete(connections).where(owned(scope));
  });
}
