-- Row-level security: the database refuses to return another tenant's rows.
--
-- The second mechanism, independent of the application. Phase 1 made every
-- query name whose data it reads, enforced by branded ids and a compile error;
-- this makes a query that forgets anyway return nothing instead of somebody
-- else's inventory. The two fail in different ways, which is the point of
-- having both.
--
-- ## Why a separate role is not optional
--
-- `DATABASE_URL` in this project's compose file is a superuser, and superusers
-- ignore RLS completely - `FORCE ROW LEVEL SECURITY` does not change that,
-- because FORCE only binds the table *owner*. Policies installed against a
-- superuser connection are decoration: they appear in `\d`, they filter
-- nothing, and nothing says so. `sightline_app` below is a plain role, so the
-- policies apply to it, and the application connects as that role via
-- DATABASE_URL_APP.
--
-- Written by hand rather than generated: drizzle-kit does not model roles,
-- grants or policies, and a migration that silently dropped them on the next
-- `generate` would be worse than none.

-- Hand-written migration; drizzle-kit's statement splitter is not involved.
-- The role may already exist from an earlier deploy, hence the guard.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sightline_app') THEN
    -- NOLOGIN would be useless here - the application logs in as this role.
    -- The password is set by the operator, not here: a password in a migration
    -- is a password in git. Until one is set this role cannot connect, which is
    -- the safe direction.
    CREATE ROLE sightline_app LOGIN;
  END IF;
END
$$;

-- DML only. No CREATE, no ownership, and explicitly no BYPASSRLS: every one of
-- those would let the application out of the policies below.
ALTER ROLE sightline_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

GRANT USAGE ON SCHEMA public TO sightline_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO sightline_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sightline_app;

-- So a table added by a later migration is reachable without remembering to
-- grant it. The policy itself is still required, and the RLS coverage test
-- fails for a tenant-scoped table that has none.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sightline_app;

-- The customer-data tables.
--
-- `users` is deliberately **not** here even though it has a tenant_id: it is
-- read before the tenant is known - a session lookup by token hash is how the
-- tenant is discovered - so a policy comparing against app.tenant_id would make
-- signing in impossible. It, `sessions`, `identities` and `tenants` are reached
-- only through the `system` handle, by a small set of functions whose whole job
-- is "find out who is asking". `eval_runs` is global and admin-only.
--
-- These nine are the ones holding an account's inventory, its scan history and
-- its conversations: the data a tenant would be horrified to see leak.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'connections',
    'scan_runs',
    'scan_units',
    'resource_snapshots',
    'relationship_snapshots',
    'conversations',
    'messages',
    'scan_jobs',
    'audit_log'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- FORCE as well, so the policies still apply if the application is ever
    -- pointed at the owner by mistake. It does not cover a superuser, which is
    -- why the separate role carries the weight - but it closes the easier half.
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    -- One policy for every command. USING filters what is visible to SELECT,
    -- UPDATE and DELETE; WITH CHECK governs what may be written, so an INSERT
    -- carrying another tenant's id is refused rather than accepted and hidden.
    --
    -- `current_setting(..., true)` returns NULL when unset rather than raising,
    -- and NULL = anything is NULL, which is not true - so an unscoped
    -- connection sees no rows and can write none. Failing closed is the whole
    -- reason for the missing-setting error in `withTenant`: without it, the
    -- symptom of escaping the context would be an empty screen.
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid)
         WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)',
      t
    );
  END LOOP;
END
$$;
