import { describe, expect, it } from "vitest";
import { assertSafeInventorySql, type GuardCause } from "./sqlGuard.js";

describe("assertSafeInventorySql", () => {
  it.each([
    "SELECT kind, count(*) FROM resources GROUP BY kind",
    "SELECT r.name FROM resources r JOIN relationships e ON e.from_arn = r.arn WHERE e.rel_type = 'CAN_REACH'",
    "WITH admins AS (SELECT arn FROM resources WHERE derived->>'isAdmin' = 'true') SELECT * FROM admins",
    "SELECT name, jsonb_array_length(properties->'ingress') AS rules FROM resources WHERE kind = 'SecurityGroup';",
    "SELECT lower(name) FROM resources WHERE position('prod' in lower(name)) > 0",
  ])("allows a read of the views: %s", (sql) => {
    expect(assertSafeInventorySql(sql)).toEqual({ ok: true });
  });

  const refusals: [string, GuardCause][] = [
    ["SELECT * FROM resource_snapshots", "table"],
    ["SELECT * FROM pg_catalog.pg_tables", "table"],
    ["SELECT * FROM users", "table"],
    ["SELECT * FROM resources WHERE arn IN (SELECT token_hash::text FROM sessions)", "table"],
    ["SELECT set_config('app.tenant_id', 'x', false)", "function"],
    ["SELECT current_setting('app.tenant_id')", "function"],
    ["SELECT pg_sleep(10)", "function"],
    ["SELECT pg_read_file('/etc/passwd')", "function"],
    ["DELETE FROM resources", "not_select"],
    ["UPDATE resources SET name = 'x'", "not_select"],
    ["SELECT 1; DROP TABLE tenants", "multiple"],
    ["SELECT * FROM resources WHERE arn = $1", "parameter"],
    ["SELEKT nonsense", "parse"],
  ];

  it.each(refusals)("refuses %s", (sql, cause) => {
    const result = assertSafeInventorySql(sql);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.cause).toBe(cause);
  });
});
