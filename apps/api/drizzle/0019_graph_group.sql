ALTER TABLE "resource_snapshots" ADD COLUMN "graph_group" text;--> statement-breakpoint
CREATE INDEX "resource_snapshots_group" ON "resource_snapshots" USING btree ("scan_id","graph_group");