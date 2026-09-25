/** Postgres connection pool and schema migration. */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import type { Resource } from "@daveio/shared";

import { cfg } from "../config.js";

export const pool = new pg.Pool({
  connectionString: cfg.DATABASE_URL,
  max: 10,
  // A scan writes thousands of rows; a slow query here means something is
  // wrong, and failing fast beats a request hanging forever.
  statement_timeout: 30_000,
});

/**
 * Apply the schema.
 *
 * Every statement is `IF NOT EXISTS`, so this is safe to run on every boot.
 * A real deployment would use versioned migrations; this is a single-tenant
 * take-home, and an idempotent schema is honest about that rather than
 * pretending to a migration history that does not exist.
 */
export async function migrate(): Promise<void> {
  const sql = await readFile(new URL("./schema.sql", import.meta.url), "utf8");
  await pool.query(sql);
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
