CREATE TABLE "policy_documents" (
	"tenant_id" uuid NOT NULL,
	"hash" text NOT NULL,
	"document" jsonb NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policy_documents_tenant_id_hash_pk" PRIMARY KEY("tenant_id","hash")
);
--> statement-breakpoint
ALTER TABLE "policy_documents" ADD CONSTRAINT "policy_documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "policy_documents" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "policy_documents"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
