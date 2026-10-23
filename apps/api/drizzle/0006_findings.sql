CREATE TABLE "findings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"category" text NOT NULL,
	"resource_arn" text NOT NULL,
	"resource_name" text NOT NULL,
	"resource_kind" text NOT NULL,
	"reason" text,
	"status" text DEFAULT 'open' NOT NULL,
	"status_reason" text,
	"status_by" uuid,
	"status_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_scan_id" uuid,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "findings_status" CHECK ("findings"."status" IN ('open','accepted','resolved')),
	CONSTRAINT "findings_category" CHECK ("findings"."category" IN ('exposed','admin','idle','unguarded'))
);
--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_status_by_users_id_fk" FOREIGN KEY ("status_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_last_scan_id_scan_runs_id_fk" FOREIGN KEY ("last_scan_id") REFERENCES "public"."scan_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "findings_identity" ON "findings" USING btree ("connection_id","category","resource_arn");--> statement-breakpoint
CREATE INDEX "findings_connection_status" ON "findings" USING btree ("connection_id","status");--> statement-breakpoint
ALTER TABLE "findings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "findings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "findings"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
