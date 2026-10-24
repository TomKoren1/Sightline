-- The audit log is append-only for the role requests run as. Entries are
-- written on the system role (src/audit/audit.ts), and a tenant's are removed
-- only with the tenant itself, by cascade - so nothing a request can reach
-- needs to rewrite or erase one, and now nothing can.
REVOKE UPDATE, DELETE, TRUNCATE ON "audit_log" FROM sightline_app;
