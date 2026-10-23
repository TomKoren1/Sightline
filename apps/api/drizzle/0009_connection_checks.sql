CREATE TABLE "connection_checks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"result" jsonb,
	"locked_by" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "connection_checks_status" CHECK ("connection_checks"."status" IN ('queued','running','done'))
);
--> statement-breakpoint
ALTER TABLE "connection_checks" ADD CONSTRAINT "connection_checks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_checks" ADD CONSTRAINT "connection_checks_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connection_checks_queued" ON "connection_checks" USING btree ("status","requested_at");--> statement-breakpoint
ALTER TABLE "connection_checks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "connection_checks" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "connection_checks"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
