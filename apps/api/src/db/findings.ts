/**
 * Findings across scans: what is new, what was fixed, what someone accepted.
 *
 * A scan's verdicts are recomputed from scratch every time and live on its
 * snapshots. That answers "what is wrong now" and nothing else: it cannot say
 * a finding is new this week, that one was fixed, or that a person looked at a
 * public bucket and decided it is meant to be public. This table is that memory.
 *
 * The rules, in the order they bite:
 *
 * - A finding is identified by account, category and ARN. Its reason may change
 *   between scans; it is the same finding.
 * - Every scan upserts what it saw. A resolved finding that is seen again is
 *   reopened, never left resolved; an accepted one stays accepted.
 * - Only a fully successful scan resolves what it did not see. A region that
 *   failed to scan is not evidence that its findings went away, and resolving
 *   them would hand a customer a clean report built on missing data.
 */

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { db, withTenant } from "./postgres.js";
import type { FindingCategory, FindingStatus } from "./schema.js";
import type { TenantId } from "../core/ids.js";
import type { Scope } from "../core/scope.js";

/**
 * What makes a snapshot row a finding of each category. The same predicates the
 * dashboard's lists filter on, so the two cannot disagree about what counts.
 */
const PREDICATES: Record<FindingCategory, { where: string; reason: string }> = {
  exposed: { where: "(derived->>'isPublic')::boolean", reason: "publicReason" },
  admin: {
    where: "kind IN ('IamRole', 'IamUser') AND (derived->>'isAdmin')::boolean",
    reason: "adminReason",
  },
  idle: { where: "(derived->>'isIdle')::boolean", reason: "idleReason" },
  unguarded: {
    where: "kind = 'S3Bucket' AND (derived->>'isUnprotected')::boolean",
    reason: "unprotectedReason",
  },
  unused: {
    where: "kind IN ('IamRole', 'IamUser') AND (derived->>'isUnused')::boolean",
    reason: "unusedReason",
  },
};

export const FINDING_CATEGORIES = Object.keys(PREDICATES) as FindingCategory[];

export interface SyncResult {
  opened: number;
  reopened: number;
  resolved: number;
  /** What is new to whoever reads the findings: opened, or back after being resolved. */
  fresh: { category: FindingCategory; name: string; kind: string }[];
}

/**
 * Bring this account's findings up to date with one scan.
 *
 * `complete` is whether the scan saw everything it was asked to; only then are
 * findings it did not see resolved.
 */
export async function syncFindings(
  scope: Scope,
  scanId: string,
  complete: boolean,
): Promise<SyncResult> {
  return withTenant(scope.tenantId, () =>
    db.transaction(async (tx) => {
      const current = sql.join(
        FINDING_CATEGORIES.map(
          (category) => sql`
          SELECT ${category}::text AS category, arn, name, kind,
                 derived->>${PREDICATES[category].reason} AS reason
            FROM resource_snapshots
           WHERE tenant_id = ${scope.tenantId} AND scan_id = ${scanId}
             AND ${sql.raw(PREDICATES[category].where)}`,
        ),
        sql` UNION ALL `,
      );

      // `xmax = 0` is true for a row this statement inserted and false for one
      // it updated: the cheapest way to tell new findings from returning ones.
      // `was` is read from the old row through the conflict's own target.
      const { rows } = await tx.execute<{
        inserted: boolean;
        was: FindingStatus | null;
        category: FindingCategory;
        resource_name: string;
        resource_kind: string;
      }>(sql`
        WITH current AS (${current}),
        previous AS (
          SELECT f.category, f.resource_arn, f.status FROM findings f
            JOIN current c ON c.category = f.category AND c.arn = f.resource_arn
           WHERE f.tenant_id = ${scope.tenantId} AND f.connection_id = ${scope.connectionId}
        )
        INSERT INTO findings AS f (id, tenant_id, connection_id, category, resource_arn,
                                   resource_name, resource_kind, reason, last_scan_id)
        SELECT gen_random_uuid(), ${scope.tenantId}, ${scope.connectionId}, c.category, c.arn,
               c.name, c.kind, c.reason, ${scanId}
          FROM current c
        ON CONFLICT (connection_id, category, resource_arn) DO UPDATE SET
          resource_name = excluded.resource_name,
          resource_kind = excluded.resource_kind,
          reason = excluded.reason,
          last_seen_at = now(),
          last_scan_id = excluded.last_scan_id,
          status = CASE WHEN f.status = 'resolved' THEN 'open' ELSE f.status END,
          resolved_at = NULL
        RETURNING (xmax = 0) AS inserted, f.category, f.resource_name, f.resource_kind,
          (SELECT p.status FROM previous p
            WHERE p.category = f.category AND p.resource_arn = f.resource_arn) AS was
      `);

      let resolved = 0;
      if (complete) {
        const gone = await tx.execute(sql`
          UPDATE findings
             SET status = 'resolved', resolved_at = now()
           WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId}
             AND status <> 'resolved'
             AND last_scan_id IS DISTINCT FROM ${scanId}
          RETURNING id
        `);
        resolved = gone.rows.length;
      }

      return {
        opened: rows.filter((r) => r.inserted).length,
        reopened: rows.filter((r) => !r.inserted && r.was === "resolved").length,
        resolved,
        fresh: rows
          .filter((r) => r.inserted || r.was === "resolved")
          .map((r) => ({ category: r.category, name: r.resource_name, kind: r.resource_kind })),
      };
    }),
  );
}

export interface FindingState {
  id: string;
  category: FindingCategory;
  resourceArn: string;
  resourceName: string;
  resourceKind: string;
  reason: string | null;
  status: FindingStatus;
  statusReason: string | null;
  statusAt: string | null;
  firstSeenAt: string;
  lastScanId: string | null;
}

/**
 * This account's findings that are not resolved: all of them, or only the
 * accepted ones and those on the given resources.
 *
 * The filter is what keeps the dashboard cheap. A large account has tens of
 * thousands of open findings and the panels show fifty of each; reading every
 * row to annotate those took two seconds at 50,000 resources.
 */
export async function listFindingStates(
  scope: Scope,
  only?: { acceptedOr: string[] },
): Promise<FindingState[]> {
  const filter = only
    ? sql`AND (status = 'accepted' OR ${JSON.stringify(only.acceptedOr)}::jsonb ? resource_arn)`
    : sql``;
  return withTenant(scope.tenantId, async () => {
    const { rows } = await db.execute<FindingState & Record<string, unknown>>(sql`
      SELECT id, category, resource_arn AS "resourceArn", resource_name AS "resourceName",
             resource_kind AS "resourceKind", reason, status, status_reason AS "statusReason",
             status_at AS "statusAt", first_seen_at AS "firstSeenAt", last_scan_id AS "lastScanId"
        FROM findings
       WHERE tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId}
         AND status <> 'resolved' ${filter}
       ORDER BY category, resource_name
    `);
    return rows.map((r) => ({
      ...r,
      statusAt: r.statusAt ? new Date(r.statusAt).toISOString() : null,
      firstSeenAt: new Date(r.firstSeenAt).toISOString(),
    }));
  });
}

/**
 * Accept a finding's risk, or take the acceptance back.
 *
 * Returns null for a finding that is not this account's, or that is resolved:
 * accepting something already fixed is a decision about nothing. The audit row
 * is written in the same transaction, so there is no acceptance without a
 * record of who made it and why.
 */
export async function setFindingStatus(
  scope: Scope,
  input: {
    id: string;
    status: Exclude<FindingStatus, "resolved">;
    reason: string | null;
    actorUserId: string | null;
  },
): Promise<FindingState | null> {
  return withTenant(scope.tenantId, () =>
    db.transaction(async (tx) => {
      const { rows } = await tx.execute<{ id: string; category: string; arn: string }>(sql`
        UPDATE findings
           SET status = ${input.status}, status_reason = ${input.reason},
               status_by = ${input.actorUserId}, status_at = now()
         WHERE id = ${input.id}
           AND tenant_id = ${scope.tenantId} AND connection_id = ${scope.connectionId}
           AND status <> 'resolved'
        RETURNING id, category, resource_arn AS arn
      `);
      const [row] = rows;
      if (!row) return null;
      await tx.execute(sql`
        INSERT INTO audit_log (id, tenant_id, actor_user_id, action, subject, detail)
        VALUES (${randomUUID()}, ${scope.tenantId}, ${input.actorUserId},
                ${input.status === "accepted" ? "finding.accepted" : "finding.reopened"},
                ${row.arn},
                ${JSON.stringify({ findingId: row.id, category: row.category, reason: input.reason })}::jsonb)
      `);
      return row.id;
    }),
  ).then(async (id) => {
    if (!id) return null;
    return (await listFindingStates(scope)).find((f) => f.id === id) ?? null;
  });
}

/** Worst first, for the cross-account list: exposure, then standing access, then cost. */
const SEVERITY = ["exposed", "admin", "unused", "unguarded", "idle"] as const;

export interface AccountFindings {
  connectionId: string;
  label: string;
  accountId: string | null;
  open: Record<FindingCategory, number>;
}

/**
 * Open findings across every account in the tenant, from the tracked
 * findings rather than each account's graph: one query however many accounts
 * there are, and it already holds what every account's last scan saw.
 */
export async function findingsAcrossAccounts(
  tenantId: TenantId,
  opts: { category?: FindingCategory; limit: number },
): Promise<{
  accounts: AccountFindings[];
  findings: {
    id: string;
    connectionId: string;
    category: FindingCategory;
    arn: string;
    name: string;
    kind: string;
    reason: string | null;
    firstSeenAt: string;
  }[];
}> {
  return withTenant(tenantId, async () => {
    const { rows: counts } = await db.execute<{
      connection_id: string;
      label: string;
      account_id: string | null;
      category: FindingCategory | null;
      n: number;
    }>(sql`
      SELECT c.id AS connection_id, c.label, c.account_id, f.category, count(f.id)::int AS n
        FROM connections c
        LEFT JOIN findings f ON f.connection_id = c.id AND f.status = 'open'
       WHERE c.tenant_id = ${tenantId} AND c.kind <> 'organization'
       GROUP BY c.id, c.label, c.account_id, f.category
       ORDER BY c.label`);
    const accounts = new Map<string, AccountFindings>();
    for (const r of counts) {
      const account = accounts.get(r.connection_id) ?? {
        connectionId: r.connection_id,
        label: r.label,
        accountId: r.account_id,
        open: Object.fromEntries(FINDING_CATEGORIES.map((c) => [c, 0])) as Record<
          FindingCategory,
          number
        >,
      };
      if (r.category) account.open[r.category] = r.n;
      accounts.set(r.connection_id, account);
    }

    const rank = sql.raw(
      `CASE category ${SEVERITY.map((c, i) => `WHEN '${c}' THEN ${i}`).join(" ")} ELSE 9 END`,
    );
    const { rows } = await db.execute<{
      id: string;
      connection_id: string;
      category: FindingCategory;
      resource_arn: string;
      resource_name: string;
      resource_kind: string;
      reason: string | null;
      first_seen_at: Date | string;
    }>(sql`
      SELECT id, connection_id, category, resource_arn, resource_name, resource_kind, reason,
             first_seen_at
        FROM findings
       WHERE tenant_id = ${tenantId} AND status = 'open'
         ${opts.category ? sql`AND category = ${opts.category}` : sql``}
       ORDER BY ${rank}, first_seen_at, resource_arn
       LIMIT ${opts.limit}`);
    return {
      accounts: [...accounts.values()],
      findings: rows.map((r) => ({
        id: r.id,
        connectionId: r.connection_id,
        category: r.category,
        arn: r.resource_arn,
        name: r.resource_name,
        kind: r.resource_kind,
        reason: r.reason,
        firstSeenAt: new Date(r.first_seen_at).toISOString(),
      })),
    };
  });
}
