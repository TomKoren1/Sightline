/**
 * The database schema, as TypeScript.
 *
 * This replaces `schema.sql` as the single definition of the tables. It is the
 * same schema: the generated migration was diffed against the SQL it replaced
 * until the two produced an identical database, which is the only way to
 * introduce an ORM to a database that already has rows in it.
 *
 * Everything is append-only per scan: a scan never updates a previous scan's
 * rows. That is what makes "what changed since the last scan?" answerable, and
 * it means a bad scan can be discarded without corrupting history.
 */

import type { Relationship, Resource, ScanStatus, ScanUnit } from "@daveio/shared";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

const tz = { withTimezone: true } as const;

export const scanRuns = pgTable(
  "scan_runs",
  {
    id: uuid("id").primaryKey(),
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
  },
  (t) => [
    index("scan_runs_account_started").on(t.accountId, t.startedAt.desc().nullsFirst()),
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
    index("resource_snapshots_arn").on(t.arn),
  ],
);

export const relationshipSnapshots = pgTable(
  "relationship_snapshots",
  {
    scanId: uuid("scan_id")
      .notNull()
      .references(() => scanRuns.id, { onDelete: "cascade" }),
    fromArn: text("from_arn").notNull(),
    toArn: text("to_arn").notNull(),
    relType: text("rel_type").$type<Relationship["type"]>().notNull(),
    properties: jsonb("properties").$type<Relationship["properties"]>().notNull().default({}),
  },
  (t) => [index("relationship_snapshots_scan").on(t.scanId)],
);

/**
 * Agent conversations, kept in Postgres rather than the graph so that chat
 * volume never competes with the queries the agent itself runs.
 */
export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey(),
  accountId: text("account_id").notNull(),
  title: text("title"),
  createdAt: timestamp("created_at", tz).notNull().defaultNow(),
});

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey(),
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
