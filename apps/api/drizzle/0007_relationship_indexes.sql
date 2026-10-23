-- The new indexes first, so a reader mid-migration is never left without one.
CREATE INDEX "relationship_snapshots_from" ON "relationship_snapshots" USING btree ("scan_id","from_arn","rel_type");--> statement-breakpoint
CREATE INDEX "relationship_snapshots_to" ON "relationship_snapshots" USING btree ("scan_id","to_arn","rel_type");--> statement-breakpoint
DROP INDEX "relationship_snapshots_scan";
