/** Postgres connection, Drizzle client, and schema migration. */

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate as runMigrations } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import type { Resource } from "@daveio/shared";

import { cfg } from "../config.js";
import * as schema from "./schema.js";

export const pool = new pg.Pool({
  connectionString: cfg.DATABASE_URL,
  max: 10,
  // A scan writes thousands of rows; a slow query here means something is
  // wrong, and failing fast beats a request hanging forever.
  statement_timeout: 30_000,
});

/**
 * The Drizzle client. Every query in this package goes through it.
 *
 * `pool` is still exported because the health check issues a bare `SELECT 1`
 * to prove the connection works, which is a liveness probe rather than a query
 * about the domain and gains nothing from the query builder.
 */
export const db = drizzle(pool, { schema });

export type Database = typeof db;

/**
 * Apply any migrations the database has not seen.
 *
 * Runs on boot, as the idempotent `schema.sql` did before it, so nothing about
 * how the project starts has changed — but the schema is now defined once, in
 * `schema.ts`, and changes to it produce a reviewable migration instead of an
 * edit to a file that was applied by being re-read.
 *
 * `fileURLToPath`, not `URL.pathname`: on Windows the latter yields
 * `/C:/projects/app/drizzle` and any directory containing a space arrives
 * percent-encoded (engineering log #36).
 */
export async function migrate(): Promise<void> {
  await runMigrations(db, {
    migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)),
  });
}

/**
 * A stable hash of the state we care about comparing between scans.
 *
 * Deliberately excludes the raw API response: AWS returns fields that change
 * on every call without anything having actually changed, and diffing on those
 * would report noise as change.
 */
export function fingerprint(
  input: Pick<Resource, "kind" | "name" | "region" | "tags" | "properties" | "derived">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        kind: input.kind,
        name: input.name,
        region: input.region,
        tags: sortKeys(input.tags),
        properties: sortKeys(input.properties),
        derived: sortKeys(input.derived),
      }),
    )
    .digest("hex");
}

/** Key order must not affect the hash, so it is normalised recursively. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

export async function closePool(): Promise<void> {
  await pool.end();
}
