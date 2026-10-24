/**
 * Who did what, for the tenant's administrators to read and take away.
 *
 * Written on `system` with the tenant named explicitly: an entry is recorded
 * after the handler finished, outside the request's own tenant context, and a
 * sign-in has no context yet. Read through `withTenant`, so row-level
 * security decides what a tenant sees. Append-only for the request path:
 * migration 0014 takes UPDATE and DELETE on the table away from the role
 * requests run as, so nothing a request can reach rewrites history.
 */

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";

import { db, system, withTenant } from "../db/postgres.js";
import type { TenantId } from "../tenancy/ids.js";

export interface AuditEntry {
  tenantId: TenantId | string;
  actorUserId: string | null;
  action: string;
  subject?: string | null;
  detail?: Record<string, unknown>;
  ip?: string | null;
}

/** The address a request came from: Cloudflare's header when it is behind the tunnel. */
export function clientIp(req: FastifyRequest): string {
  const forwarded = req.headers["cf-connecting-ip"];
  return typeof forwarded === "string" ? forwarded : req.ip;
}

export async function recordAudit(entry: AuditEntry): Promise<void> {
  await system.execute(sql`
    INSERT INTO audit_log (id, tenant_id, actor_user_id, action, subject, detail, ip)
    VALUES (${randomUUID()}, ${entry.tenantId}, ${entry.actorUserId}, ${entry.action},
            ${entry.subject ?? null}, ${JSON.stringify(entry.detail ?? {})}::jsonb,
            ${entry.ip ?? null})`);
}

export interface AuditRow {
  id: string;
  at: string;
  action: string;
  subject: string | null;
  detail: Record<string, unknown>;
  ip: string | null;
  actor: { id: string; email: string | null } | null;
}

/** Newest first. `before` is the `id` of the last row of the previous page. */
export async function listAudit(
  tenantId: TenantId,
  opts: { limit: number; before?: string | null },
): Promise<AuditRow[]> {
  return withTenant(tenantId, async () => {
    const cursor = opts.before
      ? sql`AND (a.created_at, a.id) < (SELECT created_at, id FROM audit_log WHERE id = ${opts.before})`
      : sql``;
    const { rows } = await db.execute<{
      id: string;
      created_at: Date | string;
      action: string;
      subject: string | null;
      detail: Record<string, unknown> | null;
      ip: string | null;
      actor_user_id: string | null;
      email: string | null;
    }>(sql`
      SELECT a.id, a.created_at, a.action, a.subject, a.detail, a.ip, a.actor_user_id, u.email
        FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
       WHERE a.tenant_id = ${tenantId} ${cursor}
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT ${opts.limit}`);
    return rows.map((r) => ({
      id: r.id,
      at: new Date(r.created_at).toISOString(),
      action: r.action,
      subject: r.subject,
      detail: r.detail ?? {},
      ip: r.ip,
      actor: r.actor_user_id ? { id: r.actor_user_id, email: r.email } : null,
    }));
  });
}

const CSV_COLUMNS = ["at", "action", "actor_email", "actor_id", "subject", "ip", "detail"] as const;

/** RFC 4180, and a leading `=`, `+`, `-` or `@` defused so a spreadsheet does not run it. */
function csvCell(value: string | null): string {
  if (value === null) return "";
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function auditCsv(rows: AuditRow[]): string {
  const lines = rows.map((r) =>
    [
      r.at,
      r.action,
      r.actor?.email ?? null,
      r.actor?.id ?? null,
      r.subject,
      r.ip,
      JSON.stringify(r.detail),
    ]
      .map(csvCell)
      .join(","),
  );
  return [CSV_COLUMNS.join(","), ...lines].join("\r\n") + "\r\n";
}
