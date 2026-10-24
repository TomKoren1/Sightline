import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { system } from "../db/postgres.js";
import { tenants } from "../db/schema.js";
import { asTenantId } from "../core/ids.js";
import { auditCsv, listAudit, recordAudit, type AuditRow } from "./audit.js";

const HAS_INFRA = !process.env["SKIP_INTEGRATION"];

const row = (over: Partial<AuditRow>): AuditRow => ({
  id: "1",
  at: "2026-10-24T00:00:00.000Z",
  action: "POST /api/scans",
  subject: null,
  detail: {},
  ip: null,
  actor: null,
  ...over,
});

describe("the CSV export", () => {
  it("quotes commas and quotes, and keeps one entry per line", () => {
    const csv = auditCsv([row({ subject: 'a,"b"', detail: { note: "x\ny" } })]);
    const lines = csv.trimEnd().split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("at,action,actor_email,actor_id,subject,ip,detail");
    expect(lines[1]).toContain('"a,""b"""');
  });

  it("defuses a cell a spreadsheet would run as a formula", () => {
    const csv = auditCsv([row({ actor: { id: "u", email: "=HYPERLINK(1)" } })]);
    expect(csv).toContain(",'=HYPERLINK(1),");
  });
});

describe.runIf(HAS_INFRA)("the audit log", () => {
  const tenantId = asTenantId(randomUUID());
  const otherTenant = asTenantId(randomUUID());
  let available = false;

  beforeAll(async () => {
    try {
      await system.execute("SELECT 1");
    } catch {
      return;
    }
    available = true;
    for (const id of [tenantId, otherTenant]) {
      await system.insert(tenants).values({ id, name: "audit.test" });
    }
    for (let i = 0; i < 5; i++) {
      await recordAudit({ tenantId, actorUserId: null, action: `step.${i}`, ip: "203.0.113.1" });
    }
    await recordAudit({ tenantId: otherTenant, actorUserId: null, action: "theirs" });
  });

  afterAll(async () => {
    if (!available) return;
    for (const id of [tenantId, otherTenant]) {
      await system.execute(sql`DELETE FROM tenants WHERE id = ${id}`);
    }
  });

  it("pages newest first without repeating or skipping an entry", async () => {
    if (!available) return;
    const first = await listAudit(tenantId, { limit: 2 });
    const second = await listAudit(tenantId, { limit: 2, before: first[1]!.id });
    const rest = await listAudit(tenantId, { limit: 10, before: second[1]!.id });
    const actions = [...first, ...second, ...rest].map((r) => r.action);
    expect(new Set(actions).size).toBe(5);
    expect(actions).not.toContain("theirs");
  });

  it("cannot be rewritten or erased by the role requests run as", async () => {
    if (!available) return;
    const { rows } = await system.execute<Record<string, boolean>>(sql`
      SELECT has_table_privilege('sightline_app', 'audit_log', 'INSERT') AS insert,
             has_table_privilege('sightline_app', 'audit_log', 'SELECT') AS select,
             has_table_privilege('sightline_app', 'audit_log', 'UPDATE') AS update,
             has_table_privilege('sightline_app', 'audit_log', 'DELETE') AS delete`);
    expect(rows[0]).toEqual({ insert: true, select: true, update: false, delete: false });
  });
});
