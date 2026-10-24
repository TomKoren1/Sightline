ALTER TABLE "connections" DROP CONSTRAINT "connections_kind";--> statement-breakpoint
DROP INDEX "connections_tenant_account";--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_parent_id_connections_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connections_parent" ON "connections" USING btree ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connections_tenant_account" ON "connections" USING btree ("tenant_id","account_id") WHERE "connections"."kind" <> 'organization';--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_kind" CHECK ("connections"."kind" IN ('real','demo','organization'));