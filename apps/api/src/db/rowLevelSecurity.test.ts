/**
 * The database itself refuses to return another tenant's rows.
 *
 * Branded ids make a query name whose data it reads; this asserts that one
 * which forgets anyway gets nothing instead of somebody else's inventory.
 *
 * Provisions its own login role, a member of `sightline_app`: an unconfigured
 * `DATABASE_URL_APP` would otherwise skip a security test, and setting a
 * password on the app role rotated the credential other test files were using.
 * Coverage comes from the information schema, so a new `tenant_id` table with
 * no policy fails for not being covered. Requires Postgres.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { cfg } from "../config.js";
import { system } from "./postgres.js";

const HAS_INFRA = !process.env["SKIP_INTEGRATION"];

/**
 * Tables that hold one tenant's data and must therefore be policed.
 *
 * `users` is deliberately absent despite having a `tenant_id`: it is read
 * before the tenant is known - a session lookup by token hash is how the tenant
 * gets discovered - so a policy comparing against `app.tenant_id` would make
 * signing in impossible. It, `sessions`, `identities` and `tenants` are reached
 * only from `auth/session.ts` and `auth/users.ts`, on the owner connection, and
 * the exemption is asserted below rather than assumed. `invites` is the same:
 * accepting one looks it up by its token, before the joiner's tenant is
 * known, and it is reached only from `auth/team.ts`. `api_tokens` likewise: a
 * bearer token is looked up by its hash to find the tenant, from
 * `auth/apiTokens.ts` alone.
 */
const EXEMPT = new Set(["users", "invites", "api_tokens"]);

/** The role the application connects as, which this test only reads about. */
const APP_ROLE = "sightline_app";

/** This test's own login role, a member of the above. */
const TEST_ROLE = "sightline_rls_test";
const TEST_PASSWORD = `rls-test-${randomUUID().slice(0, 8)}`;

const tenantA = randomUUID();
const tenantB = randomUUID();
const connectionA = randomUUID();
const connectionB = randomUUID();

let available = false;
let app: pg.Client | null = null;

/** `DATABASE_URL`, but as this test's restricted role. */
function appUrl(): string {
  const url = new URL(cfg.DATABASE_URL);
  url.username = TEST_ROLE;
  url.password = TEST_PASSWORD;
  return url.toString();
}

/** Run as the restricted role, scoped to one tenant. */
async function asTenant(tenantId: string, sql: string, params: unknown[] = []) {
  await app!.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId]);
  return app!.query(sql, params);
}

/** Run as the restricted role with no tenant set at all. */
async function unscoped(sql: string) {
  await app!.query(`SELECT set_config('app.tenant_id', '', false)`);
  return app!.query(sql);
}

beforeAll(async () => {
  if (!HAS_INFRA) return;
  try {
    await system.execute("SELECT 1");
  } catch {
    return;
  }

  /**
   * A login role of this test's own, inheriting the application's privileges.
   *
   * `GRANT sightline_app TO ...` rather than repeating its grants, so this
   * exercises the privilege set the application actually has. Dropped again in
   * `afterAll`; roles are cluster-wide, so leaving one behind would be litter
   * in every other database on the server.
   */
  await system.execute(`DROP ROLE IF EXISTS ${TEST_ROLE}` as never);
  await system.execute(
    `CREATE ROLE ${TEST_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${TEST_PASSWORD}'` as never,
  );
  await system.execute(`GRANT ${APP_ROLE} TO ${TEST_ROLE}` as never);

  app = new pg.Client({ connectionString: appUrl() });
  await app.connect();

  // Two tenants, each with a connection and a scan, seeded as the owner -
  // which is the only role that *can* write rows for two different tenants.
  for (const [tenant, connection, account] of [
    [tenantA, connectionA, "111111111111"],
    [tenantB, connectionB, "222222222222"],
  ] as const) {
    await system.execute(
      `INSERT INTO tenants (id, name) VALUES ('${tenant}', 'rls.test')` as never,
    );
    await system.execute(
      `INSERT INTO connections (id, tenant_id, kind, label, external_id_source)
       VALUES ('${connection}', '${tenant}', 'demo', 'rls.test', 'demo')` as never,
    );
    await system.execute(
      `INSERT INTO scan_runs (id, tenant_id, connection_id, account_id, status, started_at)
       VALUES ('${randomUUID()}', '${tenant}', '${connection}', '${account}', 'succeeded', now())` as never,
    );
  }

  available = true;
});

afterAll(async () => {
  await app?.end().catch(() => undefined);
  if (!available) return;
  for (const tenant of [tenantA, tenantB]) {
    await system.execute(`DELETE FROM tenants WHERE id = '${tenant}'` as never);
  }
  // The connection above has to be closed first, or the role is still in use.
  await system.execute(`DROP ROLE IF EXISTS ${TEST_ROLE}` as never).catch(() => undefined);
});

describe.runIf(HAS_INFRA)("row-level security", () => {
  it("has a database and a restricted role to talk to", () => {
    // Without this the file passes vacuously, which for a security test is the
    // one outcome worse than failing.
    expect(available, "Postgres or the restricted role is unavailable").toBe(true);
  });

  it("is not the owner's experience, which is why the role matters", async () => {
    if (!available) return;
    /**
     * The control for the whole file. The owner is a superuser here and sees
     * everything; if it did not, the isolation asserted below could be an
     * artefact of the fixture rather than of the policies.
     */
    const { rows } = await system.execute("SELECT count(*)::int AS n FROM scan_runs");
    expect(Number((rows[0] as { n: number }).n)).toBeGreaterThanOrEqual(2);
  });

  it("is enforced against the role the application actually connects as", async () => {
    if (!available) return;
    /**
     * Read-only, and about `sightline_app` rather than this test's role.
     *
     * Either flag would make every policy in the database decoration, and the
     * migration sets both off - but a later `ALTER ROLE` by an operator trying
     * to fix something else would turn the whole guarantee off with nothing
     * failing. This is the assertion that notices.
     */
    const { rows } = await system.execute(
      `SELECT rolsuper AS super, rolbypassrls AS bypass FROM pg_roles
        WHERE rolname = '${APP_ROLE}'` as never,
    );
    expect(rows[0], `${APP_ROLE} does not exist, so the migration has not run`).toBeDefined();
    expect(rows[0]).toMatchObject({ super: false, bypass: false });
  });

  it("is enforced against this test's role too, which inherits that one's grants", async () => {
    if (!available) return;
    const { rows } = await app!.query(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    );
    // Otherwise everything below passes for the wrong reason.
    expect(rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false });
  });

  describe("reading", () => {
    it("shows a tenant only its own rows", async () => {
      if (!available) return;
      const { rows } = await asTenant(
        tenantA,
        "SELECT count(*)::int AS n, min(account_id) AS account FROM scan_runs",
      );
      expect(rows[0]).toMatchObject({ n: 1, account: "111111111111" });
    });

    it("shows nothing when the other tenant's id is named explicitly", async () => {
      if (!available) return;
      // The case the application's own `WHERE tenant_id` cannot protect against,
      // because here the query is deliberately asking for somebody else.
      const { rows } = await asTenant(
        tenantA,
        `SELECT count(*)::int AS n FROM scan_runs WHERE tenant_id = '${tenantB}'`,
      );
      expect(rows[0]).toMatchObject({ n: 0 });
    });

    it("shows nothing at all when no tenant is set", async () => {
      if (!available) return;
      /**
       * Failing closed, and the reason `withTenant` can afford to throw rather
       * than guess: a query that escapes its context returns an empty result,
       * not another tenant's rows.
       *
       * Both spellings of "no tenant" are checked, because they are not the
       * same value and the first version of the policy only handled one. An
       * unset setting is NULL, and `tenant_id = NULL` is NULL, which is not
       * true - fine. But `withTenant` *clears* the setting to `''` before
       * returning the connection to the pool, and `''::uuid` raises rather than
       * yielding NULL: the query failed with `invalid input syntax for type
       * uuid` instead of simply finding nothing. `NULLIF` in the policy makes
       * the two mean the same thing.
       */
      const cleared = await unscoped("SELECT count(*)::int AS n FROM scan_runs");
      expect(cleared.rows[0], "cleared to the empty string").toMatchObject({ n: 0 });

      // A connection on which it was never set at all, which is the other way
      // a query can escape its context.
      const fresh = new pg.Client({ connectionString: appUrl() });
      await fresh.connect();
      try {
        const { rows } = await fresh.query("SELECT count(*)::int AS n FROM scan_runs");
        expect(rows[0], "never set").toMatchObject({ n: 0 });
      } finally {
        await fresh.end();
      }
    });
  });

  describe("writing", () => {
    it("refuses an insert carrying another tenant's id", async () => {
      if (!available) return;
      // `WITH CHECK`, not just `USING`: without it the row would be accepted
      // and then be invisible to everyone, which is worse than a refusal.
      await expect(
        asTenant(
          tenantA,
          `INSERT INTO scan_runs (id, tenant_id, connection_id, account_id, status, started_at)
           VALUES (gen_random_uuid(), '${tenantB}', '${connectionB}', '999999999999', 'succeeded', now())`,
        ),
      ).rejects.toThrow(/row-level security/i);
    });

    it("changes nothing when updating another tenant's rows", async () => {
      if (!available) return;
      const result = await asTenant(
        tenantA,
        `UPDATE scan_runs SET account_id = 'tampered' WHERE tenant_id = '${tenantB}'`,
      );
      expect(result.rowCount).toBe(0);
    });

    it("deletes nothing when deleting another tenant's rows", async () => {
      if (!available) return;
      const result = await asTenant(
        tenantA,
        `DELETE FROM scan_runs WHERE tenant_id = '${tenantB}'`,
      );
      expect(result.rowCount).toBe(0);

      // And the row is still there, as the owner sees it. A rowCount of zero
      // with the row gone would mean the count was lying.
      const { rows } = await system.execute(
        `SELECT count(*)::int AS n FROM scan_runs WHERE tenant_id = '${tenantB}'` as never,
      );
      expect(Number((rows[0] as { n: number }).n)).toBe(1);
    });
  });

  describe("coverage", () => {
    it("polices every table that holds a tenant's data", async () => {
      if (!available) return;

      /**
       * Computed from the catalogue, so a table added later cannot escape by
       * nobody remembering to add it to a list here. The only list is the
       * exemption, and the next test argues for it.
       */
      const { rows } = await system.execute(
        `
        SELECT c.relname AS table,
               c.relrowsecurity AS enabled,
               c.relforcerowsecurity AS forced,
               (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::int AS policies
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relkind = 'r'
           AND EXISTS (
                 SELECT 1 FROM pg_attribute a
                  WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
               )
      `,
      );

      const unpoliced = (
        rows as { table: string; enabled: boolean; forced: boolean; policies: number }[]
      )
        .filter((r) => !EXEMPT.has(r.table))
        .filter((r) => !r.enabled || !r.forced || r.policies < 1)
        .map((r) => `${r.table} (enabled=${r.enabled} forced=${r.forced} policies=${r.policies})`);

      expect(
        unpoliced,
        "these tables carry a tenant_id and are not protected by row-level security. Add " +
          "ENABLE/FORCE ROW LEVEL SECURITY and a tenant_isolation policy in a migration, or add " +
          "the table to EXEMPT here with a reason it cannot be scoped to one tenant.",
      ).toEqual([]);

      // And it found something, rather than passing because the query returned
      // nothing at all.
      expect(rows.length).toBeGreaterThan(5);
    });

    it("still has a reason for each exemption", async () => {
      if (!available) return;

      /**
       * The exemption is only defensible while the lookup really is
       * pre-tenant. If `users` ever stops being read before the tenant is
       * known, it should be policed like everything else - so this asserts the
       * property the exemption rests on rather than the exemption itself.
       */
      const { rows } = await system.execute(
        `
        SELECT count(*)::int AS n FROM pg_policy p
          JOIN pg_class c ON c.oid = p.polrelid
         WHERE c.relname = 'users'
      `,
      );
      expect(
        Number((rows[0] as { n: number }).n),
        "`users` now has a policy, so it is no longer exempt - remove it from EXEMPT",
      ).toBe(0);

      // The tables it is read alongside must be reachable only from the two
      // auth modules. A third importer would be the thing to look at.
      expect(EXEMPT.size, "every exemption needs its own argument in the comment above").toBe(3);
    });
  });
});
