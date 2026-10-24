/**
 * Every tenant's health, for the operator: who is failing, and why.
 *
 * Metrics carry no tenant label, deliberately - a label per tenant is a
 * series per tenant, and a tenant's name in a dashboard. So "why did
 * customer X's scan fail" is answered here, from Postgres, across tenants on
 * `system`, and only for a session whose own tenant carries the operator
 * flag. Counts and the last error, never inventory: what support needs to
 * start, not a way to read a customer's estate.
 */

import type * as api from "@sightline/shared/api";
import { sql } from "drizzle-orm";

import { system } from "../db/postgres.js";

export type TenantHealth = api.TenantHealth;

export async function tenantHealth(): Promise<TenantHealth[]> {
  const { rows } = await system.execute<{
    id: string;
    name: string;
    created_at: Date | string;
    members: number;
    connections: number;
    active_scans: number;
    failed_7d: number;
    succeeded_7d: number;
    last_status: string | null;
    last_at: Date | string | null;
    last_error: string | null;
    questions_24h: number;
    tokens_24h: number;
  }>(sql`
    SELECT t.id, t.name, t.created_at,
           (SELECT count(*)::int FROM users u WHERE u.tenant_id = t.id) AS members,
           (SELECT count(*)::int FROM connections c
             WHERE c.tenant_id = t.id AND c.kind <> 'organization') AS connections,
           (SELECT count(*)::int FROM scan_jobs j
             WHERE j.tenant_id = t.id AND j.status IN ('queued', 'running')) AS active_scans,
           (SELECT count(*)::int FROM scan_jobs j WHERE j.tenant_id = t.id
               AND j.status = 'failed' AND j.queued_at > now() - interval '7 days') AS failed_7d,
           (SELECT count(*)::int FROM scan_jobs j WHERE j.tenant_id = t.id
               AND j.status IN ('succeeded', 'partial')
               AND j.queued_at > now() - interval '7 days') AS succeeded_7d,
           last.status AS last_status, last.finished_at AS last_at, last.error AS last_error,
           (SELECT count(*)::int FROM messages m WHERE m.tenant_id = t.id AND m.role = 'user'
               AND m.created_at > now() - interval '24 hours') AS questions_24h,
           (SELECT coalesce(sum(m.input_tokens + m.output_tokens), 0)::int FROM messages m
             WHERE m.tenant_id = t.id AND m.role = 'assistant'
               AND m.created_at > now() - interval '24 hours') AS tokens_24h
      FROM tenants t
      LEFT JOIN LATERAL (
        SELECT j.status, j.finished_at, j.error FROM scan_jobs j
         WHERE j.tenant_id = t.id ORDER BY j.queued_at DESC LIMIT 1
      ) last ON true
     ORDER BY failed_7d DESC, t.created_at DESC
     LIMIT 500`);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: new Date(r.created_at).toISOString(),
    members: r.members,
    connections: r.connections,
    activeScans: r.active_scans,
    scansFailed7d: r.failed_7d,
    scansSucceeded7d: r.succeeded_7d,
    lastScan: r.last_status
      ? {
          status: r.last_status,
          at: r.last_at ? new Date(r.last_at).toISOString() : null,
          error: r.last_error,
        }
      : null,
    questions24h: r.questions_24h,
    tokens24h: r.tokens_24h,
  }));
}
