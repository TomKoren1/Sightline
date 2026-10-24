/**
 * The database schema, as TypeScript.
 *
 * The single definition of the tables, replacing a hand-written schema file. It is the
 * same schema: the generated migration was diffed against the SQL it replaced
 * until the two produced an identical database, which is the only way to
 * introduce an ORM to a database that already has rows in it.
 *
 * Everything is append-only per scan: a scan never updates a previous scan's
 * rows. That is what makes "what changed since the last scan?" answerable, and
 * it means a bad scan can be discarded without corrupting history.
 */

import type { Relationship, Resource, ScanStatus, ScanUnit } from "@sightline/shared";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const tz = { withTimezone: true } as const;

export const scanRuns = pgTable(
  "scan_runs",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    /** Denormalised from the connection, and no longer what anything filters on. */
    accountId: text("account_id").notNull(),
    status: text("status").$type<ScanStatus>().notNull(),
    startedAt: timestamp("started_at", tz).notNull(),
    finishedAt: timestamp("finished_at", tz),
    regions: text("regions")
      .array()
      .notNull()
      .default(sql`'{}'`),
    resourceCount: integer("resource_count").notNull().default(0),
    relationshipCount: integer("relationship_count").notNull().default(0),
    apiCalls: integer("api_calls").notNull().default(0),
    error: text("error"),
    /**
     * When this scan became its connection's graph, or null if it never did.
     *
     * This single column *is* the flip in write-then-flip: a scan writes its
     * snapshots while the previous scan stays readable, and setting this is
     * what makes the new one current. The connection's graph is
     * therefore "its latest scan with a projected_at", which needs no pointer
     * to keep in step and leaves a record of which scans were ever projected.
     */
    projectedAt: timestamp("projected_at", tz),
  },
  (t) => [
    index("scan_runs_projected").on(t.connectionId, t.projectedAt.desc().nullsLast()),
    // Scoped to the connection, because that is what every read filters on
    // now: "the latest scan" is meaningless across tenants.
    index("scan_runs_connection_started").on(t.connectionId, t.startedAt.desc().nullsFirst()),
    // Kept as a database constraint rather than only as a TypeScript union: the
    // type is erased at runtime, and a bad status reaching this column would
    // make `getLatestScan` silently skip a scan that had in fact succeeded.
    check("scan_runs_status", sql`${t.status} IN ('running','succeeded','partial','failed')`),
  ],
);

/**
 * One row per (service, region): the unit of partial failure, and the table the
 * UI reads to tell a user which part of their account is missing.
 *
 * `region` is 'global' rather than NULL for services that are not regional, so
 * it can take part in the primary key.
 */
export const scanUnits = pgTable(
  "scan_units",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    scanId: uuid("scan_id")
      .notNull()
      .references(() => scanRuns.id, { onDelete: "cascade" }),
    service: text("service").$type<ScanUnit["service"]>().notNull(),
    region: text("region").notNull(),
    status: text("status").$type<ScanUnit["status"]>().notNull(),
    resourceCount: integer("resource_count").notNull().default(0),
    apiCalls: integer("api_calls").notNull().default(0),
    durationMs: integer("duration_ms").notNull().default(0),
    error: text("error"),
    errorCode: text("error_code"),
    startedAt: timestamp("started_at", tz),
    finishedAt: timestamp("finished_at", tz),
  },
  (t) => [primaryKey({ columns: [t.scanId, t.service, t.region] })],
);

/**
 * An immutable snapshot of every resource as of one scan.
 *
 * `fingerprint` is a hash of the queryable state, so diffing two scans is an
 * index-backed join rather than a JSONB comparison across thousands of rows.
 */
export const resourceSnapshots = pgTable(
  "resource_snapshots",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    scanId: uuid("scan_id")
      .notNull()
      .references(() => scanRuns.id, { onDelete: "cascade" }),
    arn: text("arn").notNull(),
    kind: text("kind").$type<Resource["kind"]>().notNull(),
    name: text("name").notNull(),
    region: text("region"),
    accountId: text("account_id").notNull(),
    tags: jsonb("tags").$type<Resource["tags"]>().notNull().default({}),
    properties: jsonb("properties").$type<Resource["properties"]>().notNull().default({}),
    derived: jsonb("derived").$type<Resource["derived"]>().notNull().default({}),
    fingerprint: text("fingerprint").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.scanId, t.arn] }),
    index("resource_snapshots_kind").on(t.scanId, t.kind),
    index("resource_snapshots_tenant_arn").on(t.tenantId, t.arn),
  ],
);

export const relationshipSnapshots = pgTable(
  "relationship_snapshots",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    scanId: uuid("scan_id")
      .notNull()
      .references(() => scanRuns.id, { onDelete: "cascade" }),
    fromArn: text("from_arn").notNull(),
    toArn: text("to_arn").notNull(),
    relType: text("rel_type").$type<Relationship["type"]>().notNull(),
    properties: jsonb("properties").$type<Relationship["properties"]>().notNull().default({}),
  },
  /**
   * Both directions, led by the scan, because every graph question is "edges
   * of this type into (or out of) these resources, in this scan". Scan alone
   * made each such join read the scan's every edge: at 110,000 edges the admin
   * and open-security-group panels took half a minute each.
   */
  (t) => [
    index("relationship_snapshots_from").on(t.scanId, t.fromArn, t.relType),
    index("relationship_snapshots_to").on(t.scanId, t.toArn, t.relType),
  ],
);

/**
 * Agent conversations, kept in Postgres rather than the graph so that chat
 * volume never competes with the queries the agent itself runs.
 */
export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  connectionId: uuid("connection_id")
    .notNull()
    .references(() => connections.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  title: text("title"),
  createdAt: timestamp("created_at", tz).notNull().defaultNow(),
});

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: text("role").$type<"user" | "assistant">().notNull(),
    content: text("content").notNull(),
    // The audit trail: which tools ran, what they returned, which ARNs the
    // answer cited, and whether any of those citations were unsupported.
    toolCalls: jsonb("tool_calls").notNull().default([]),
    citations: jsonb("citations").notNull().default([]),
    warnings: jsonb("warnings").notNull().default([]),
    scanId: uuid("scan_id").references(() => scanRuns.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", tz).notNull().defaultNow(),
  },
  (t) => [
    index("messages_conversation").on(t.conversationId, t.createdAt),
    /**
     * For the chat quota, which counts a tenant's questions in the last hour.
     *
     * Without it that count is a sequential scan of every message every tenant
     * has ever sent, on the path of every question - the quota would become
     * the slowest thing about asking one.
     */
    index("messages_tenant_asked").on(t.tenantId, t.createdAt),
    check("messages_role", sql`${t.role} IN ('user','assistant')`),
  ],
);

/**
 * Eval results, so a regression in answer quality is visible over time rather
 * than discovered in a demo.
 */
export const evalRuns = pgTable("eval_runs", {
  id: uuid("id").primaryKey(),
  startedAt: timestamp("started_at", tz).notNull().defaultNow(),
  model: text("model").notNull(),
  total: integer("total").notNull().default(0),
  passed: integer("passed").notNull().default(0),
  meanF1: real("mean_f1").notNull().default(0),
  results: jsonb("results").notNull().default([]),
});

/* ---------------------------------------------------------------------------
 * Tenancy
 *
 * A tenant is who is asking; a connection is which of their AWS accounts they
 * are asking about. Every table above holding customer data carries both, with
 * `NOT NULL` and **no default** - a default would let an insert that forgot the
 * tenant succeed, landing the row in whichever tenant the default names, which
 * in a shared database is somebody else's account.
 * ------------------------------------------------------------------------- */

/**
 * Encrypted bytes. Drizzle has no `bytea`, and the alternative - base64 in a
 * text column - makes it possible to read a secret with a plain SELECT and not
 * notice.
 */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", tz).notNull().defaultNow(),
  /** Admin-only facilities, and the demo account. One flag, on the tenant. */
  isAdmin: boolean("is_admin").notNull().default(false),
});

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /**
     * Unique, so one person cannot end up with two accounts by signing in with
     * a second provider. A provider's email is only trusted when the provider
     * says it is verified - see `auth/`.
     */
    email: text("email").notNull().unique(),
    name: text("name"),
    avatarUrl: text("avatar_url"),
    createdAt: timestamp("created_at", tz).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", tz),
    /**
     * What this user may do in their tenant (`auth/roles.ts`). Owner by
     * default, because every user who arrives without an invite is the only
     * member of a tenant made for them.
     */
    role: text("role").$type<TeamRole>().notNull().default("owner"),
  },
  (t) => [
    index("users_tenant").on(t.tenantId),
    check("users_role", sql`${t.role} IN ('owner','admin','member','viewer')`),
  ],
);

export type TeamRole = "owner" | "admin" | "member" | "viewer";

/**
 * An invitation to join a tenant: a link copied by hand, so there is no email
 * to send and nothing to pay for. Only the token's hash is kept - the link is
 * shown once, to whoever made it - and it works once, within a week.
 */
export const invites = pgTable(
  "invites",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    tokenHash: bytea("token_hash").notNull().unique(),
    role: text("role").$type<TeamRole>().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", tz).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", tz).notNull(),
    acceptedBy: uuid("accepted_by").references(() => users.id, { onDelete: "set null" }),
    acceptedAt: timestamp("accepted_at", tz),
    revokedAt: timestamp("revoked_at", tz),
  },
  (t) => [
    index("invites_tenant").on(t.tenantId, t.createdAt.desc()),
    // An invite can grant anything but ownership, which is given by an owner.
    check("invites_role", sql`${t.role} IN ('admin','member','viewer')`),
  ],
);

/**
 * One row per external identity, so one user can hold both Google and GitHub.
 *
 * Keyed on the provider's **subject**, never on email: subjects are stable,
 * while email addresses are renamed and reassigned inside a Workspace, and
 * matching on one is how a person ends up inside somebody else's account.
 */
export const identities = pgTable(
  "identities",
  {
    provider: text("provider").$type<"google" | "github">().notNull(),
    subject: text("subject").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", tz).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.subject] }),
    index("identities_user").on(t.userId),
    check("identities_provider", sql`${t.provider} IN ('google','github')`),
  ],
);

/**
 * Sessions, server-side, so one can be revoked.
 *
 * The cookie carries a random token; only its hash is stored, so a dump of
 * this table is not a set of usable sessions. A signed stateless cookie would
 * need no table, but could not be revoked - which for a service holding access
 * to other people's AWS accounts is the property worth having.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey(),
    tokenHash: bytea("token_hash").notNull().unique(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", tz).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", tz).notNull(),
    lastUsedAt: timestamp("last_used_at", tz),
    userAgent: text("user_agent"),
    ip: text("ip"),
  },
  (t) => [index("sessions_user").on(t.userId), index("sessions_expiry").on(t.expiresAt)],
);

/**
 * One connected AWS account. Several per tenant, which is the point.
 *
 * The **account id is pinned on first verification** rather than read from the
 * role ARN at scan time, so a role ARN edited later cannot quietly repoint an
 * existing connection, its history and its graph at a different account.
 */
export const connections = pgTable(
  "connections",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** `demo` is the moto fixture and is admin-only; `real` is a customer account. */
    kind: text("kind").$type<"real" | "demo">().notNull(),
    /** The tenant's own name for it - "prod", "staging". */
    label: text("label").notNull(),
    roleArn: text("role_arn"),
    /** Null until the first successful assume-role says what it really is. */
    accountId: text("account_id"),
    /**
     * Where the external id comes from, named rather than inferred from a null.
     *
     *   `stored` - encrypted in the column below. The only legal value in
     *              hosted mode, and the only one that is actually a secret.
     *   `config` - `AWS_EXTERNAL_ID` in a self-hosted `.env`. Encrypting a copy
     *              would protect nothing: the plaintext is already on the same
     *              disk, two files away.
     *   `demo`   - the published constant the mock fixture accepts. Not a
     *              secret, and pretending otherwise would be theatre.
     *
     * The alternative was a nullable column plus a rule about when null is
     * allowed, which puts the rule somewhere no constraint can check.
     */
    externalIdSource: text("external_id_source").$type<"stored" | "config" | "demo">().notNull(),
    /**
     * Issued when this row is created, because the customer needs it to deploy
     * the stack that creates the role. Never regenerated on save: doing so left
     * the stack and the service disagreeing, which surfaces as AccessDenied
     * with nothing to suggest why.
     */
    externalIdEncrypted: bytea("external_id_encrypted"),
    status: text("status")
      .$type<"pending" | "verified" | "failed" | "disconnected">()
      .notNull()
      .default("pending"),
    lastError: text("last_error"),
    /** Which published template they deployed, so a stale one is detected not diagnosed. */
    templateVersion: text("template_version"),
    scanRegions: text("scan_regions")
      .array()
      .notNull()
      .default(sql`'{}'`),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", tz).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", tz).notNull().defaultNow(),
    lastVerifiedAt: timestamp("last_verified_at", tz),
    lastScanAt: timestamp("last_scan_at", tz),
  },
  (t) => [
    index("connections_tenant").on(t.tenantId),
    /**
     * One connection per account per tenant. `account_id` is null until
     * verified and Postgres permits many nulls in a unique index, so several
     * pending connections coexist while only one verified one can.
     */
    uniqueIndex("connections_tenant_account").on(t.tenantId, t.accountId),
    check("connections_kind", sql`${t.kind} IN ('real','demo')`),
    check(
      "connections_external_id_source",
      sql`${t.externalIdSource} IN ('stored','config','demo')`,
    ),
    // The pair has to agree: `stored` is the only source with bytes, and bytes
    // with any other source would be a secret nothing reads.
    check(
      "connections_external_id_present",
      sql`(${t.externalIdSource} = 'stored') = (${t.externalIdEncrypted} IS NOT NULL)`,
    ),
    check("connections_status", sql`${t.status} IN ('pending','verified','failed','disconnected')`),
  ],
);

/**
 * The scan queue.
 *
 * Postgres rather than Redis: `FOR UPDATE SKIP LOCKED` to claim, `LISTEN` to
 * wake, and the queue is then transactional with the data it produces. One
 * fewer thing to deploy, back up and lose.
 */
export const scanJobs = pgTable(
  "scan_jobs",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    status: text("status")
      .$type<"queued" | "running" | "succeeded" | "partial" | "failed" | "cancelled">()
      .notNull()
      .default("queued"),
    requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    lockedBy: text("locked_by"),
    lockedAt: timestamp("locked_at", tz),
    /** So a worker that died leaves a job another can reclaim. */
    heartbeatAt: timestamp("heartbeat_at", tz),
    scanId: uuid("scan_id").references(() => scanRuns.id, { onDelete: "set null" }),
    queuedAt: timestamp("queued_at", tz).notNull().defaultNow(),
    startedAt: timestamp("started_at", tz),
    finishedAt: timestamp("finished_at", tz),
    error: text("error"),
  },
  (t) => [
    index("scan_jobs_claim").on(t.status, t.queuedAt),
    index("scan_jobs_tenant").on(t.tenantId),
    /**
     * One scan per connection at a time, as a database guarantee.
     *
     * This replaces an in-process `Set`, which was correct only while there was
     * one API process - the moment there are two replicas, or an API and a
     * worker, two scans of the same account run concurrently and race on the
     * same snapshot rows and the same graph scope. A partial unique index
     * cannot be raced: the second INSERT fails, whichever process makes it.
     *
     * Partial rather than total, because finished jobs must accumulate - the
     * history is the point. `queued` and `running` are named explicitly rather
     * than expressed as "not finished", so a status added later has to be
     * considered here instead of silently joining or leaving the set.
     */
    uniqueIndex("scan_jobs_one_active_per_connection")
      .on(t.connectionId)
      .where(sql`${t.status} IN ('queued','running')`),
    check(
      "scan_jobs_status",
      sql`${t.status} IN ('queued','running','succeeded','partial','failed','cancelled')`,
    ),
  ],
);

/**
 * Who did what. Cheap, and not optional for a product that asks customers to
 * trust it with access to their cloud.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
    /** Null when the actor is the system - a scheduled sweep, a worker. */
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    /** What it was done to: a connection id, an account id, a user id. */
    subject: text("subject"),
    detail: jsonb("detail").notNull().default({}),
    ip: text("ip"),
    createdAt: timestamp("created_at", tz).notNull().defaultNow(),
  },
  (t) => [index("audit_log_tenant").on(t.tenantId, t.createdAt.desc())],
);

/**
 * A finding, tracked across scans.
 *
 * The verdicts live on each scan's snapshots and are recomputed every time;
 * this is what a person decided about one. One row per account, category and
 * resource, so "accepted" survives the next scan and a resolved finding that
 * comes back reopens rather than arriving as new.
 */
export const findings = pgTable(
  "findings",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    category: text("category").$type<FindingCategory>().notNull(),
    resourceArn: text("resource_arn").notNull(),
    resourceName: text("resource_name").notNull(),
    resourceKind: text("resource_kind").notNull(),
    reason: text("reason"),
    status: text("status").$type<FindingStatus>().notNull().default("open"),
    /** Why it was accepted. Required to accept: a risk without a reason is a shrug. */
    statusReason: text("status_reason"),
    statusBy: uuid("status_by").references(() => users.id, { onDelete: "set null" }),
    statusAt: timestamp("status_at", tz),
    firstSeenAt: timestamp("first_seen_at", tz).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", tz).notNull().defaultNow(),
    lastScanId: uuid("last_scan_id").references(() => scanRuns.id, { onDelete: "set null" }),
    resolvedAt: timestamp("resolved_at", tz),
  },
  (t) => [
    uniqueIndex("findings_identity").on(t.connectionId, t.category, t.resourceArn),
    index("findings_connection_status").on(t.connectionId, t.status),
    check("findings_status", sql`${t.status} IN ('open','accepted','resolved')`),
    check("findings_category", sql`${t.category} IN ('exposed','admin','idle','unguarded')`),
  ],
);

export type FindingCategory = "exposed" | "admin" | "idle" | "unguarded";
export type FindingStatus = "open" | "accepted" | "resolved";

/**
 * IAM policy documents, stored once per tenant by content hash.
 *
 * Every principal carries the documents of the policies it holds, so an
 * AWS-managed policy attached to a thousand roles was stored a thousand times
 * per scan: 75% of a 50,000-resource scan's payload. Snapshots now hold a
 * `documentRef` where the document was, and reads put it back.
 *
 * `last_used_at` is what lets pruning delete documents safely without
 * scanning every snapshot for references: each save refreshes the documents it
 * refers to, so one older than the tenant's oldest retained scan is
 * referenced by nothing.
 */
export const policyDocuments = pgTable(
  "policy_documents",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    hash: text("hash").notNull(),
    document: jsonb("document").notNull(),
    lastUsedAt: timestamp("last_used_at", tz).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.hash] })],
);

/**
 * A request to try a connection's role, answered by the worker.
 *
 * Only the worker holds the identity that can assume customers' roles, so the
 * API cannot test a connection itself. It writes one of these, the worker
 * answers it - usually within a second, over `NOTIFY` - and the API reads the
 * answer back. Rows older than an hour are deleted as new ones arrive.
 */
export const connectionChecks = pgTable(
  "connection_checks",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    status: text("status").$type<"queued" | "running" | "done">().notNull().default("queued"),
    result: jsonb("result"),
    lockedBy: text("locked_by"),
    requestedAt: timestamp("requested_at", tz).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", tz),
  },
  (t) => [
    index("connection_checks_queued").on(t.status, t.requestedAt),
    check("connection_checks_status", sql`${t.status} IN ('queued','running','done')`),
  ],
);
