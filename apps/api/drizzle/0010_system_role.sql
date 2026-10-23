-- A cross-tenant role that is not the owner.
--
-- The `system` handle does what no tenant context can: look a session up by
-- token hash, claim the next job for whichever tenant owns it, prune. It ran as
-- the owner, so every API and worker pod held credentials that could also drop
-- tables. `sightline_system` gets the same reach over rows - DML everywhere,
-- past the policies - and nothing over the schema. The owner is then needed
-- only by the migrate Job.
--
-- Hand-written, like 0004: drizzle-kit does not model roles or grants.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sightline_system') THEN
    -- No password here, for 0004's reason; `npm run db:app-role` sets it.
    CREATE ROLE sightline_system LOGIN;
  END IF;
  BEGIN
    -- BYPASSRLS is the whole point, and only a superuser may grant it. On a
    -- database where the migrator is not one, say so instead of failing every
    -- later migration; the role is then unused until someone grants it.
    ALTER ROLE sightline_system NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE WARNING 'sightline_system could not be given BYPASSRLS; keep DATABASE_URL as the owner until a superuser grants it.';
  END;
END
$$;

GRANT USAGE ON SCHEMA public TO sightline_system;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO sightline_system;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sightline_system;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sightline_system;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO sightline_system;

-- So a pod can refuse to start against a schema behind its build.
GRANT USAGE ON SCHEMA drizzle TO sightline_system;
GRANT SELECT ON drizzle.__drizzle_migrations TO sightline_system;

-- ANALYZE is the owner's to run, and the scan job runs it after a large write
-- (see `refreshSnapshotStatistics`). Owner rights for exactly that statement.
CREATE OR REPLACE FUNCTION refresh_snapshot_statistics() RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  ANALYZE resource_snapshots;
  ANALYZE relationship_snapshots;
END
$$;
REVOKE ALL ON FUNCTION refresh_snapshot_statistics() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION refresh_snapshot_statistics() TO sightline_system;
