-- Baseline migration: the schema as it stood when the ORM was adopted.
--
-- Hand-edited after generation, deliberately. `drizzle-kit` emits plain
-- `CREATE TABLE`, which is right for a database that does not exist yet and
-- wrong for one that already holds scan history — it would fail on the first
-- table and the only way forward would be dropping the volume.
--
-- So this migration is idempotent, and it also *adopts*: it renames the
-- constraints an older database already has to the names this schema uses, so
-- that a database migrated from the old schema and a database created from
-- scratch end up byte-identical. That equivalence is asserted by
-- `src/db/adoption.test.ts`.
--
-- This applies to the baseline only. Migrations generated from here on describe
-- changes rather than the whole schema, and are used exactly as generated.

CREATE TABLE IF NOT EXISTS "conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"title" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "eval_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"model" text NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"passed" integer DEFAULT 0 NOT NULL,
	"mean_f1" real DEFAULT 0 NOT NULL,
	"results" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"tool_calls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scan_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_role" CHECK ("messages"."role" IN ('user','assistant'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "relationship_snapshots" (
	"scan_id" uuid NOT NULL,
	"from_arn" text NOT NULL,
	"to_arn" text NOT NULL,
	"rel_type" text NOT NULL,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "resource_snapshots" (
	"scan_id" uuid NOT NULL,
	"arn" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"region" text,
	"account_id" text NOT NULL,
	"tags" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"derived" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fingerprint" text NOT NULL,
	CONSTRAINT "resource_snapshots_scan_id_arn_pk" PRIMARY KEY("scan_id","arn")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scan_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"regions" text[] DEFAULT '{}' NOT NULL,
	"resource_count" integer DEFAULT 0 NOT NULL,
	"relationship_count" integer DEFAULT 0 NOT NULL,
	"api_calls" integer DEFAULT 0 NOT NULL,
	"error" text,
	CONSTRAINT "scan_runs_status" CHECK ("scan_runs"."status" IN ('running','succeeded','partial','failed'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scan_units" (
	"scan_id" uuid NOT NULL,
	"service" text NOT NULL,
	"region" text NOT NULL,
	"status" text NOT NULL,
	"resource_count" integer DEFAULT 0 NOT NULL,
	"api_calls" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"error" text,
	"error_code" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "scan_units_scan_id_service_region_pk" PRIMARY KEY("scan_id","service","region")
);
--> statement-breakpoint
--
-- Adoption: give the pre-existing constraints the names this schema expects.
--
-- A database created by the `schema.sql` that this migration replaces holds
-- exactly these constraints, under the names Postgres generates when they are
-- declared inline. Drizzle names them differently, and a name is all
-- `ADD CONSTRAINT` can check: without this, adding the foreign keys below
-- succeeds on such a database and leaves every one of them defined twice —
-- enforced twice on every insert, and invisible until you count them.
--
-- Renamed rather than dropped and re-added, because re-adding a foreign key
-- takes a lock and revalidates every existing row, and renaming is a catalogue
-- update. `undefined_object` means the constraint is not there, which is the
-- normal case on a new database.
--
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "messages" RENAME CONSTRAINT "messages_role_check" TO "messages_role";
EXCEPTION
  WHEN undefined_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "scan_runs" RENAME CONSTRAINT "scan_runs_status_check" TO "scan_runs_status";
EXCEPTION
  WHEN undefined_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "resource_snapshots" RENAME CONSTRAINT "resource_snapshots_pkey" TO "resource_snapshots_scan_id_arn_pk";
EXCEPTION
  WHEN undefined_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "scan_units" RENAME CONSTRAINT "scan_units_pkey" TO "scan_units_scan_id_service_region_pk";
EXCEPTION
  WHEN undefined_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "messages" RENAME CONSTRAINT "messages_conversation_id_fkey" TO "messages_conversation_id_conversations_id_fk";
EXCEPTION
  WHEN undefined_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "messages" RENAME CONSTRAINT "messages_scan_id_fkey" TO "messages_scan_id_scan_runs_id_fk";
EXCEPTION
  WHEN undefined_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "relationship_snapshots" RENAME CONSTRAINT "relationship_snapshots_scan_id_fkey" TO "relationship_snapshots_scan_id_scan_runs_id_fk";
EXCEPTION
  WHEN undefined_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "resource_snapshots" RENAME CONSTRAINT "resource_snapshots_scan_id_fkey" TO "resource_snapshots_scan_id_scan_runs_id_fk";
EXCEPTION
  WHEN undefined_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "scan_units" RENAME CONSTRAINT "scan_units_scan_id_fkey" TO "scan_units_scan_id_scan_runs_id_fk";
EXCEPTION
  WHEN undefined_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "messages" ADD CONSTRAINT "messages_scan_id_scan_runs_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scan_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "relationship_snapshots" ADD CONSTRAINT "relationship_snapshots_scan_id_scan_runs_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scan_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "resource_snapshots" ADD CONSTRAINT "resource_snapshots_scan_id_scan_runs_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scan_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "scan_units" ADD CONSTRAINT "scan_units_scan_id_scan_runs_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scan_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_conversation" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "relationship_snapshots_scan" ON "relationship_snapshots" USING btree ("scan_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "resource_snapshots_kind" ON "resource_snapshots" USING btree ("scan_id","kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "resource_snapshots_arn" ON "resource_snapshots" USING btree ("arn");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scan_runs_account_started" ON "scan_runs" USING btree ("account_id","started_at" DESC NULLS FIRST);