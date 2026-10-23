/**
 * The list questions: filters on computed verdicts, each one a base query and
 * the order its rows come in.
 *
 * Kept apart so one definition serves two readers. The UI and the CLI take the
 * first page as an array. The agent takes a `Page`: the true total, counts by
 * kind and region computed in Postgres, and an offset - safe to page by,
 * because a scan's snapshot never changes once written. Every order ends in
 * the ARN, so a page boundary never falls between two equal keys.
 */

import { sql, type SQL } from "drizzle-orm";
import { INTERNET_ARN } from "@sightline/shared";

import { clamp, flag, read, type GraphScope, type ResourceRow } from "./graphRead.js";

interface Finder<P> {
  /** Every matching row, unordered and unlimited; `b` in `order` is this. */
  base: (params: P, r: SQL, e: SQL) => SQL;
  order: SQL;
  defaultLimit?: number;
}

interface Filters {
  kind?: string;
  region?: string;
  nameContains?: string;
  text?: string;
}
type Params = Filters & { limit?: number };

const FINDERS = {
  listResources: {
    base: (p, r) => {
      const kind = p.kind ?? null;
      const region = p.region ?? null;
      const name = p.nameContains?.toLowerCase() ?? null;
      return sql`
        SELECT arn, kind, name, region,
               ${flag("r", "isPublic")} AS "isPublic",
               ${flag("r", "isAdmin")} AS "isAdmin",
               ${flag("r", "isIdle")} AS "isIdle"
          FROM ${r} r
         WHERE kind <> 'Internet'
           AND (${kind}::text IS NULL OR kind = ${kind})
           AND (${region}::text IS NULL OR region = ${region})
           AND (${name}::text IS NULL OR position(${name} in lower(name)) > 0)`;
    },
    order: sql`b.kind, b.name, b.arn`,
  },

  /**
   * Resources an anonymous caller can reach. `isPublic` was decided at ingest
   * by analysers that are unit tested, and `publicReason` records the evidence.
   */
  findPublicResources: {
    base: (p, r) => {
      const kind = p.kind ?? null;
      return sql`
        SELECT arn, kind, name, region, derived->>'publicReason' AS reason
          FROM ${r} r
         WHERE ${flag("r", "isPublic")} AND (${kind}::text IS NULL OR kind = ${kind})`;
    },
    order: sql`b.kind, b.name, b.arn`,
  },

  /**
   * Principals that are effectively administrators, and what uses them. An
   * admin role on a running instance is an incident; one nothing references is
   * cleanup. A user has nothing to be used by, which is itself the finding.
   */
  findAdminPrincipals: {
    base: (_p, r, e) => sql`
      WITH admins AS (
        SELECT arn, kind, name, derived FROM ${r} r
         WHERE kind IN ('IamRole', 'IamUser') AND ${flag("r", "isAdmin")}
      ),
      users AS (
        SELECT a.arn AS admin, i.arn, i.name, i.kind
          FROM admins a
          JOIN ${e} pr ON pr.rel_type = 'PROVIDES_ROLE' AND pr.to_arn = a.arn
          JOIN ${e} hp ON hp.rel_type = 'HAS_INSTANCE_PROFILE' AND hp.to_arn = pr.from_arn
          JOIN ${r} i ON i.arn = hp.from_arn AND i.kind = 'Ec2Instance'
        UNION
        SELECT a.arn, f.arn, f.name, f.kind
          FROM admins a
          JOIN ${e} ex ON ex.rel_type = 'EXECUTES_AS' AND ex.to_arn = a.arn
          JOIN ${r} f ON f.arn = ex.from_arn
        UNION
        -- A cluster whose pods can assume it through IRSA or Pod Identity.
        SELECT a.arn, c.arn, c.name, c.kind
          FROM admins a
          JOIN ${e} ca ON ca.rel_type = 'CAN_ASSUME' AND ca.to_arn = a.arn
          JOIN ${r} c ON c.arn = ca.from_arn AND c.kind = 'EksCluster'
      )
      SELECT a.arn, a.kind, a.name, NULL::text AS region,
             a.derived->>'adminReason' AS reason,
             a.derived->>'adminVia' AS "adminVia",
             coalesce(jsonb_agg(jsonb_build_object('arn', u.arn, 'name', u.name, 'kind', u.kind))
                      FILTER (WHERE u.arn IS NOT NULL), '[]'::jsonb) AS "usedBy",
             count(u.arn)::int AS "useCount"
        FROM admins a LEFT JOIN users u ON u.admin = a.arn
       GROUP BY a.arn, a.kind, a.name, a.derived`,
    order: sql`b."useCount" DESC, b.name, b.arn`,
  },

  /**
   * Instances outside a private subnet: in a subnet that routes to an internet
   * gateway, or in no subnet at all - the rarer half, and easier to miss.
   */
  findInstancesInPublicSubnets: {
    base: (_p, r, e) => sql`
      SELECT i.arn, 'Ec2Instance' AS kind, i.name, i.region,
             i.properties->>'state' AS state,
             coalesce(s.name, '(none)') AS subnet,
             CASE WHEN s.arn IS NULL THEN 'Instance is not associated with any subnet'
                  ELSE s.derived->>'publicReason' END AS reason
        FROM ${r} i
        LEFT JOIN ${e} sn ON sn.rel_type = 'IN_SUBNET' AND sn.from_arn = i.arn
        LEFT JOIN ${r} s ON s.arn = sn.to_arn AND s.kind = 'Subnet'
       WHERE i.kind = 'Ec2Instance' AND (s.arn IS NULL OR ${flag("s", "isPublic")})`,
    order: sql`b.name, b.arn`,
  },

  /** Billable and doing nothing, most expensive first. */
  findIdleResources: {
    base: (_p, r) => sql`
      SELECT arn, kind, name, region, derived->>'idleReason' AS reason,
             coalesce((derived->>'estimatedMonthlyCostUsd')::float8, 0) AS "estimatedMonthlyCostUsd"
        FROM ${r} r
       WHERE ${flag("r", "isIdle")}`,
    order: sql`b."estimatedMonthlyCostUsd" DESC, b.name, b.arn`,
  },

  /**
   * Buckets nothing would stop from being made public. Not public: Block Public
   * Access being off grants nobody anything. A posture finding, not exposure.
   */
  findUnprotectedBuckets: {
    base: (_p, r) => sql`
      SELECT arn, 'S3Bucket' AS kind, name, region, derived->>'unprotectedReason' AS reason,
             coalesce(${flag("r", "isPublic")}, false) AS "isPublic"
        FROM ${r} r
       WHERE kind = 'S3Bucket' AND ${flag("r", "isUnprotected")}`,
    order: sql`b.name, b.arn`,
  },

  /** Resources the internet reaches directly, with the rule that lets it. */
  findOpenSecurityGroups: {
    base: (_p, r, e) => sql`
      SELECT t.arn, t.kind, t.name, t.region,
             array_agg(DISTINCT e.properties->>'ports') AS ports,
             (array_agg(e.properties->>'via' ORDER BY e.properties->>'via'))[1] AS "securityGroup",
             (array_agg(e.properties->>'reason' ORDER BY e.properties->>'via'))[1] AS reason
        FROM ${e} e JOIN ${r} t ON t.arn = e.to_arn
       WHERE e.rel_type = 'CAN_REACH' AND e.from_arn = ${INTERNET_ARN}
       GROUP BY t.arn, t.kind, t.name, t.region`,
    order: sql`b.name, b.arn`,
  },

  /** Free-text search across resource names, tags and ARNs. */
  searchResources: {
    base: (p, r) => {
      const text = (p.text ?? "").toLowerCase();
      return sql`
        SELECT arn, kind, name, region
          FROM ${r} r
         WHERE position(${text} in lower(name)) > 0
            OR position(${text} in lower(tags::text)) > 0
            OR position(${text} in lower(arn)) > 0`;
    },
    order: sql`b.kind, b.name, b.arn`,
    defaultLimit: 25,
  },
} satisfies Record<string, Finder<Filters>>;

export type FinderName = keyof typeof FINDERS;

/** The first `limit` rows, as the UI and the CLI read them. */
function rowsOf(name: FinderName, scope: GraphScope, params: Params): Promise<ResourceRow[]> {
  const finder: Finder<Filters> = FINDERS[name];
  return read<ResourceRow>(
    scope,
    (r, e) => sql`
      SELECT * FROM (${finder.base(params, r, e)}) b
       ORDER BY ${finder.order}
       LIMIT ${clamp(params.limit, finder.defaultLimit)}`,
  );
}

export interface Page {
  rows: ResourceRow[];
  /** Every matching row, not only these. */
  total: number;
  /** How many matching rows come before these. */
  offset: number;
  byKind: { kind: string; count: number }[];
  byRegion: { region: string | null; count: number }[];
}

/** One page, with the totals and counts the whole result would have. */
export async function pageOf(
  name: FinderName,
  scope: GraphScope,
  params: Params & { offset?: number },
): Promise<Page> {
  const finder: Finder<Filters> = FINDERS[name];
  const offset = Math.max(0, Math.floor(Number.isFinite(params.offset) ? params.offset! : 0));
  const [rows, counts] = await Promise.all([
    read<ResourceRow>(
      scope,
      (r, e) => sql`
        SELECT * FROM (${finder.base(params, r, e)}) b
         ORDER BY ${finder.order}
         LIMIT ${clamp(params.limit, finder.defaultLimit)} OFFSET ${offset}`,
    ),
    read<{ kind: string | null; region: string | null; byKind: number; count: number }>(
      scope,
      (r, e) => sql`
        SELECT kind, region, GROUPING(region) AS "byKind", count(*)::int AS count
          FROM (${finder.base(params, r, e)}) b
         GROUP BY GROUPING SETS ((kind), (region))
         ORDER BY count DESC`,
    ),
  ]);
  const byKind = counts
    .filter((c) => c.byKind === 1)
    .map((c) => ({ kind: c.kind!, count: c.count }));
  return {
    rows,
    total: byKind.reduce((sum, c) => sum + c.count, 0),
    offset,
    byKind,
    byRegion: counts
      .filter((c) => c.byKind === 0)
      .map((c) => ({ region: c.region, count: c.count })),
  };
}

export const listResources = (scope: GraphScope, params: Params) =>
  rowsOf("listResources", scope, params);
export const findPublicResources = (scope: GraphScope, params: Params = {}) =>
  rowsOf("findPublicResources", scope, params);
export const findAdminPrincipals = (scope: GraphScope, params: Params = {}) =>
  rowsOf("findAdminPrincipals", scope, params);
export const findInstancesInPublicSubnets = (scope: GraphScope, params: Params = {}) =>
  rowsOf("findInstancesInPublicSubnets", scope, params);
export const findIdleResources = (scope: GraphScope, params: Params = {}) =>
  rowsOf("findIdleResources", scope, params);
export const findUnprotectedBuckets = (scope: GraphScope, params: Params = {}) =>
  rowsOf("findUnprotectedBuckets", scope, params);
export const findOpenSecurityGroups = (scope: GraphScope, params: Params = {}) =>
  rowsOf("findOpenSecurityGroups", scope, params);
export const searchResources = (scope: GraphScope, params: Params & { text: string }) =>
  rowsOf("searchResources", scope, params);
