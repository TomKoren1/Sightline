/**
 * A tenant's webhook: set, read back as its host only, removed, and told when
 * a scan opens findings someone should look at today - exposure and
 * standing admin access. Idle spend and posture wait for the dashboard.
 */

import { eq, sql } from "drizzle-orm";

import { cfg } from "../config.js";
import type { SyncResult } from "../db/findings.js";
import { db, withTenant } from "../db/postgres.js";
import { webhooks } from "../db/schema.js";
import type { TenantId } from "../tenancy/ids.js";
import { decryptSecret, encryptSecret } from "../tenancy/secrets.js";
import { deliver, refuseUrl, type Delivery } from "./webhook.js";

/** The categories worth interrupting someone for. */
const URGENT = new Set(["exposed", "admin"]);
const LISTED = 5;

export class WebhookRefused extends Error {}

export interface WebhookView {
  configured: boolean;
  host: string | null;
  lastDeliveryAt: string | null;
  lastStatus: string | null;
}

export async function getWebhook(tenantId: TenantId): Promise<WebhookView> {
  return withTenant(tenantId, async () => {
    const [row] = await db
      .select({
        host: webhooks.host,
        lastDeliveryAt: webhooks.lastDeliveryAt,
        lastStatus: webhooks.lastStatus,
      })
      .from(webhooks)
      .where(eq(webhooks.tenantId, tenantId));
    return {
      configured: Boolean(row),
      host: row?.host ?? null,
      lastDeliveryAt: row?.lastDeliveryAt?.toISOString() ?? null,
      lastStatus: row?.lastStatus ?? null,
    };
  });
}

export async function setWebhook(tenantId: TenantId, url: string, by: string | null) {
  const refused = refuseUrl(url);
  if (refused) throw new WebhookRefused(refused);
  const host = new URL(url).hostname;
  const urlCiphertext = await encryptSecret(url);
  // Awaited inside: a drizzle query runs when awaited, and outside the
  // callback it would run outside the tenant's context.
  await withTenant(tenantId, async () => {
    await db
      .insert(webhooks)
      .values({ tenantId, urlCiphertext, host, createdBy: by })
      .onConflictDoUpdate({
        target: webhooks.tenantId,
        set: { urlCiphertext, host, createdBy: by, createdAt: new Date(), lastStatus: null },
      });
  });
}

export async function deleteWebhook(tenantId: TenantId): Promise<void> {
  await withTenant(tenantId, async () => {
    await db.delete(webhooks).where(eq(webhooks.tenantId, tenantId));
  });
}

async function send(tenantId: TenantId, text: string): Promise<Delivery | null> {
  const url = await withTenant(tenantId, async () => {
    const [row] = await db
      .select({ urlCiphertext: webhooks.urlCiphertext })
      .from(webhooks)
      .where(eq(webhooks.tenantId, tenantId));
    return row ? decryptSecret(row.urlCiphertext) : null;
  });
  if (!url) return null;
  // `text` is what Slack, Teams' workflows and Mattermost all read.
  const result = await deliver(url, { text });
  await withTenant(tenantId, async () => {
    await db
      .update(webhooks)
      .set({ lastDeliveryAt: sql`now()`, lastStatus: result.status })
      .where(eq(webhooks.tenantId, tenantId));
  });
  return result;
}

export const sendTest = (tenantId: TenantId) =>
  send(tenantId, "Sightline is connected. New exposed and admin findings will be posted here.");

/** The message for a scan's new urgent findings, or null when there are none. */
export function describeNew(
  account: { label: string; accountId: string | null },
  fresh: SyncResult["fresh"],
): string | null {
  const urgent = fresh.filter((f) => URGENT.has(f.category));
  if (urgent.length === 0) return null;
  const count = (c: string) => urgent.filter((f) => f.category === c).length;
  const parts = [
    count("exposed") ? `${count("exposed")} exposed to the internet` : "",
    count("admin") ? `${count("admin")} with admin access` : "",
  ].filter(Boolean);
  const where = account.accountId ? `${account.label} (${account.accountId})` : account.label;
  const lines = urgent
    .slice(0, LISTED)
    .map((f) => `• ${f.name} (${f.kind}) - ${f.category === "admin" ? "admin" : "exposed"}`);
  const more = urgent.length > LISTED ? [`and ${urgent.length - LISTED} more`] : [];
  const link = cfg.PUBLIC_BASE_URL ? [cfg.PUBLIC_BASE_URL] : [];
  return [
    `Sightline: ${where} has ${parts.join(" and ")} since the last scan.`,
    ...lines,
    ...more,
    ...link,
  ].join("\n");
}

/** After a scan: best effort, never failing the scan it reports on. */
export async function notifyNewFindings(
  tenantId: TenantId,
  account: { label: string; accountId: string | null },
  fresh: SyncResult["fresh"],
): Promise<Delivery | null> {
  const text = describeNew(account, fresh);
  return text ? send(tenantId, text) : null;
}
