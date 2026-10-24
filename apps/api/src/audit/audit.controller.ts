/** The audit log, for administrators: a page at a time, or all of it as a file. */

import { BadRequestException, Controller, Get, Query, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";

import { MinRole } from "../auth/roles.js";
import { CurrentScope } from "../tenancy/currentScope.decorator.js";
import type { Scope } from "../tenancy/scope.js";
import { auditCsv, listAudit, type AuditRow } from "./audit.js";

const PAGE = 100;
/** An export is one request; past this, page through the list instead. */
const EXPORT_MAX = 50_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller("api/audit")
export class AuditController {
  @MinRole("admin")
  @Get()
  async list(@CurrentScope() scope: Scope, @Query() query: { before?: string; limit?: string }) {
    if (query.before !== undefined && !UUID.test(query.before)) {
      throw new BadRequestException({ error: "`before` is the id of an entry." });
    }
    const limit = Math.min(Math.max(Number(query.limit) || PAGE, 1), 500);
    const entries = await listAudit(scope.tenantId, { limit, before: query.before ?? null });
    return {
      entries,
      next: entries.length === limit ? (entries[entries.length - 1]?.id ?? null) : null,
    };
  }

  @MinRole("admin")
  @Get("export")
  async export(
    @CurrentScope() scope: Scope,
    @Query() query: { format?: string },
    @Res() reply: FastifyReply,
  ) {
    const format = query.format ?? "csv";
    if (format !== "csv" && format !== "json") {
      throw new BadRequestException({ error: "`format` is csv or json." });
    }
    const rows: AuditRow[] = await listAudit(scope.tenantId, { limit: EXPORT_MAX });
    const stamp = new Date().toISOString().slice(0, 10);
    return reply
      .header("content-disposition", `attachment; filename="sightline-audit-${stamp}.${format}"`)
      .header("cache-control", "no-store")
      .type(format === "csv" ? "text/csv; charset=utf-8" : "application/json")
      .send(format === "csv" ? auditCsv(rows) : JSON.stringify({ entries: rows }));
  }
}
