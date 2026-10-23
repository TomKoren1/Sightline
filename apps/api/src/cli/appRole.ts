#!/usr/bin/env tsx
/**
 * Give the restricted database role the password `DATABASE_URL_APP` names.
 *
 *   npm run db:app-role -w @sightline/api
 *
 * The migration creates `sightline_app` without one, deliberately: a password
 * in a migration is a password in git, and a role with no password cannot
 * connect - which is the safe direction for the gap between the two. This is
 * the step that closes it, run by whoever holds the credentials.
 *
 * It exists because the alternative is a README instruction to run some SQL,
 * and an instruction is a thing people mistype. It is also the only way to be
 * sure the password the application will present is the password the role
 * actually has: both are read from the same string.
 *
 * Idempotent, and safe to re-run after a rotation.
 */

import { closePool, system } from "../db/postgres.js";
import { cfg } from "../config.js";

/** The role and password the application is configured to connect as. */
function configured(): { role: string; password: string } {
  if (!cfg.DATABASE_URL_APP) {
    throw new Error(
      "DATABASE_URL_APP is not set, so there is no role to configure. It is the restricted " +
        "role row-level security applies to; see .env.example.",
    );
  }
  if (cfg.DATABASE_URL_APP === cfg.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL_APP is the same as DATABASE_URL, so the application would connect as the " +
        "owner and row-level security would do nothing. They must be different roles.",
    );
  }

  const url = new URL(cfg.DATABASE_URL_APP);
  const role = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  if (!role || !password) {
    throw new Error("DATABASE_URL_APP must carry both a username and a password.");
  }
  return { role, password };
}

try {
  const { role, password } = configured();

  /**
   * Parameterised where it can be, quoted where it cannot.
   *
   * `ALTER ROLE` takes neither the role name nor the password as a bind
   * parameter, so both are interpolated - and both come from configuration
   * rather than from a request, which is the only reason that is acceptable
   * here. `quote_ident` and `quote_literal` do the escaping rather than this
   * file guessing at it.
   */
  await system.execute(
    `DO $$
     BEGIN
       EXECUTE format('ALTER ROLE %I PASSWORD %L', ${quoteLiteral(role)}, ${quoteLiteral(password)});
     END
     $$;`,
  );

  // Proved rather than assumed: the role existing and the password being set
  // are two things, and only a connection shows both.
  const { Client } = await import("pg");
  const probe = new Client({ connectionString: cfg.DATABASE_URL_APP });
  await probe.connect();
  const { rows } = await probe.query<{ super: boolean; bypass: boolean }>(
    "SELECT rolsuper AS super, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user",
  );
  await probe.end();

  // `||` and not `??`: either flag being true is the problem, and `??` would
  // only fall through on null, treating `false` as the answer.
  const privileged = Boolean(rows[0]?.super) || Boolean(rows[0]?.bypass);
  if (privileged) {
    // Either flag makes every policy in the database decoration, so this is a
    // failure and not a warning.
    console.error(
      `\n${role} is a superuser or has BYPASSRLS, so row-level security would not apply to it.` +
        `\nRun: ALTER ROLE ${role} NOSUPERUSER NOBYPASSRLS;`,
    );
    process.exitCode = 1;
  } else {
    console.log(`\n${role} can connect, and row-level security applies to it.`);
  }

  if (cfg.DATABASE_URL_SYSTEM) await configureSystemRole(cfg.DATABASE_URL_SYSTEM);
} catch (err) {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await closePool();
}

/** A single-quoted SQL literal, escaped the way Postgres expects. */
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The cross-tenant role the API and worker use instead of the owner (0010):
 * it must bypass the policies, as `system` exists to, and must not be able to
 * change the schema, which is the reason it is not the owner.
 */
async function configureSystemRole(connectionString: string): Promise<void> {
  const url = new URL(connectionString);
  const role = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  if (!role || !password) {
    throw new Error("DATABASE_URL_SYSTEM must carry both a username and a password.");
  }
  await system.execute(
    `DO $$
     BEGIN
       EXECUTE format('ALTER ROLE %I PASSWORD %L', ${quoteLiteral(role)}, ${quoteLiteral(password)});
     END
     $$;`,
  );
  const { Client } = await import("pg");
  const probe = new Client({ connectionString });
  await probe.connect();
  const { rows } = await probe.query<{ super: boolean; bypass: boolean; owns: number }>(
    `SELECT r.rolsuper AS super, r.rolbypassrls AS bypass,
            (SELECT count(*)::int FROM pg_tables WHERE tableowner = current_user) AS owns
       FROM pg_roles r WHERE r.rolname = current_user`,
  );
  await probe.end();
  const [r] = rows;
  if (!r?.bypass || r.super || r.owns > 0) {
    console.error(
      `\n${role} must have BYPASSRLS, and be neither a superuser nor the owner of any table.` +
        `\nRun: ALTER ROLE ${role} NOSUPERUSER BYPASSRLS;`,
    );
    process.exitCode = 1;
  } else {
    console.log(`${role} can connect, reaches every tenant's rows, and cannot change the schema.`);
  }
}
