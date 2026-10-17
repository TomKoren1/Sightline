CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"subject" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"role_arn" text,
	"account_id" text,
	"external_id_source" text NOT NULL,
	"external_id_encrypted" "bytea",
	"status" text DEFAULT 'pending' NOT NULL,
	"last_error" text,
	"template_version" text,
	"scan_regions" text[] DEFAULT '{}' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_verified_at" timestamp with time zone,
	"last_scan_at" timestamp with time zone,
	CONSTRAINT "connections_kind" CHECK ("connections"."kind" IN ('real','demo')),
	CONSTRAINT "connections_external_id_source" CHECK ("connections"."external_id_source" IN ('stored','config','demo')),
	CONSTRAINT "connections_external_id_present" CHECK (("connections"."external_id_source" = 'stored') = ("connections"."external_id_encrypted" IS NOT NULL)),
	CONSTRAINT "connections_status" CHECK ("connections"."status" IN ('pending','verified','failed','disconnected'))
);
--> statement-breakpoint
CREATE TABLE "identities" (
	"provider" text NOT NULL,
	"subject" text NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identities_provider_subject_pk" PRIMARY KEY("provider","subject"),
	CONSTRAINT "identities_provider" CHECK ("identities"."provider" IN ('google','github'))
);
--> statement-breakpoint
CREATE TABLE "scan_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"requested_by" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"locked_by" text,
	"locked_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"scan_id" uuid,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error" text,
	CONSTRAINT "scan_jobs_status" CHECK ("scan_jobs"."status" IN ('queued','running','succeeded','partial','failed','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"user_agent" text,
	"ip" text,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"avatar_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
--
-- Backfill. Everything below the CREATE TABLEs exists because this database
-- already has rows in it: the new columns are added nullable, filled, and only
-- then tightened. The alternative - ADD COLUMN ... NOT NULL - fails outright on
-- any installation that has ever run a scan.
--
-- The tenant id is the fixed one `tenancy/local.ts` refers to by constant. A
-- generated uuid would differ between machines and make the code unable to name
-- the row it just created.
--
INSERT INTO tenants (id, name, is_admin)
VALUES ('00000000-0000-0000-0000-000000000001', 'Local', true)
ON CONFLICT (id) DO NOTHING;--> statement-breakpoint
INSERT INTO connections (id, tenant_id, kind, label, external_id_source, status, last_verified_at)
VALUES ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001',
        'demo', 'Demo account', 'demo', 'verified', now())
ON CONFLICT (id) DO NOTHING;--> statement-breakpoint
--
-- The real connection is created only if this database holds scans that did not
-- come from the mock account - otherwise a fresh clone, which has no real
-- account configured, would show an unused pending connection it never asked
-- for. `role_arn` is left null and filled from `.env` on the next boot.
--
INSERT INTO connections (id, tenant_id, kind, label, external_id_source, status)
SELECT '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001',
       'real', 'My AWS', 'config', 'pending'
WHERE EXISTS (SELECT 1 FROM scan_runs WHERE account_id <> '123456789012')
   OR EXISTS (SELECT 1 FROM conversations WHERE account_id <> '123456789012')
ON CONFLICT (id) DO NOTHING;--> statement-breakpoint
DROP INDEX "resource_snapshots_arn";--> statement-breakpoint
DROP INDEX "scan_runs_account_started";--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "connection_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "relationship_snapshots" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "resource_snapshots" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "scan_runs" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "scan_runs" ADD COLUMN "connection_id" uuid;--> statement-breakpoint
ALTER TABLE "scan_runs" ADD COLUMN "projected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "scan_units" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
--
-- Existing scans are attributed by the account they actually recorded, not to
-- whichever connection is convenient: the mock account id is the one the
-- fixture uses, and anything else came from a real account. Guessing here would
-- file one account's inventory under another's name, which is the failure the
-- `account_id` pin exists to prevent.
--
UPDATE scan_runs SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;--> statement-breakpoint
UPDATE scan_runs SET connection_id = CASE
    WHEN account_id = '123456789012' THEN '00000000-0000-0000-0000-000000000002'::uuid
    ELSE '00000000-0000-0000-0000-000000000003'::uuid
  END
  WHERE connection_id IS NULL;--> statement-breakpoint
UPDATE scan_units u SET tenant_id = r.tenant_id
  FROM scan_runs r WHERE r.id = u.scan_id AND u.tenant_id IS NULL;--> statement-breakpoint
UPDATE resource_snapshots x SET tenant_id = r.tenant_id
  FROM scan_runs r WHERE r.id = x.scan_id AND x.tenant_id IS NULL;--> statement-breakpoint
UPDATE relationship_snapshots x SET tenant_id = r.tenant_id
  FROM scan_runs r WHERE r.id = x.scan_id AND x.tenant_id IS NULL;--> statement-breakpoint
UPDATE conversations SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;--> statement-breakpoint
UPDATE conversations SET connection_id = CASE
    WHEN account_id = '123456789012' THEN '00000000-0000-0000-0000-000000000002'::uuid
    ELSE '00000000-0000-0000-0000-000000000003'::uuid
  END
  WHERE connection_id IS NULL;--> statement-breakpoint
UPDATE messages m SET tenant_id = c.tenant_id
  FROM conversations c WHERE c.id = m.conversation_id AND m.tenant_id IS NULL;--> statement-breakpoint
--
-- Tightened only now, and with no column default: a default would let an insert
-- that forgot the tenant succeed, landing the row in whichever tenant the
-- default names - which in a shared database is somebody else's account.
--
ALTER TABLE "scan_runs" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "scan_runs" ALTER COLUMN "connection_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "scan_units" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "resource_snapshots" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "relationship_snapshots" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "connection_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "tenant_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identities" ADD CONSTRAINT "identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_jobs" ADD CONSTRAINT "scan_jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_jobs" ADD CONSTRAINT "scan_jobs_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_jobs" ADD CONSTRAINT "scan_jobs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_jobs" ADD CONSTRAINT "scan_jobs_scan_id_scan_runs_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scan_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_tenant" ON "audit_log" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "connections_tenant" ON "connections" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connections_tenant_account" ON "connections" USING btree ("tenant_id","account_id");--> statement-breakpoint
CREATE INDEX "identities_user" ON "identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "scan_jobs_claim" ON "scan_jobs" USING btree ("status","queued_at");--> statement-breakpoint
CREATE INDEX "scan_jobs_tenant" ON "scan_jobs" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "sessions_user" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expiry" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "users_tenant" ON "users" USING btree ("tenant_id");--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_snapshots" ADD CONSTRAINT "relationship_snapshots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_snapshots" ADD CONSTRAINT "resource_snapshots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_runs" ADD CONSTRAINT "scan_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_runs" ADD CONSTRAINT "scan_runs_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_units" ADD CONSTRAINT "scan_units_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "resource_snapshots_tenant_arn" ON "resource_snapshots" USING btree ("tenant_id","arn");--> statement-breakpoint
CREATE INDEX "scan_runs_projected" ON "scan_runs" USING btree ("connection_id","projected_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "scan_runs_connection_started" ON "scan_runs" USING btree ("connection_id","started_at" DESC NULLS FIRST);