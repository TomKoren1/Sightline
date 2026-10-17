-- Make the policies total over whatever `app.tenant_id` happens to contain.
--
-- 0004 compared against `current_setting('app.tenant_id', true)::uuid`, which
-- is right for two of the three states and wrong for the third:
--
--   * set to a uuid      -> filters to that tenant.                   correct
--   * never set          -> NULL, and `tenant_id = NULL` is NULL,
--                           so no rows.                              correct
--   * set to ''          -> `''::uuid` RAISES.                        wrong
--
-- The empty string is not a corner case: `withTenant` clears the setting that
-- way before handing the connection back to the pool, so the very next query on
-- a reused connection - if one ever escaped its tenant context - would fail with
-- `invalid input syntax for type uuid: ""`. That is still fail-closed, no rows
-- are returned either way, but it is a diagnostic that points at the type system
-- instead of at the missing context, and the error a developer sees is the whole
-- value of failing loudly.
--
-- `NULLIF(..., '')` makes the empty string mean the same as unset: no tenant,
-- therefore no rows. Found by the test asserting the unset case, which is the
-- assertion that looked least likely to matter.
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
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)
         WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t
    );
  END LOOP;
END
$$;
