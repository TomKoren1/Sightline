/**
 * Migrating an existing database must produce the same schema as creating one.
 *
 * The ORM was introduced to a project that already had users with data in it,
 * so the baseline migration has to do two different jobs: build the schema on a
 * new database, and adopt one that the `schema.sql` it replaced had already
 * built. Those two paths are easy to let drift, and the drift is silent.
 *
 * It was not hypothetical. The first version of the baseline wrapped each
 * `ADD CONSTRAINT` in `EXCEPTION WHEN duplicate_object`, which reads like it
 * handles "the constraint is already there". It does not: it catches a clash of
 * *names*, and Drizzle names constraints differently from Postgres's defaults.
 * Applied to a real database it added a second copy of every foreign key —
 * five became ten, each one enforced twice on every insert, and nothing
 * anywhere failed. It surfaced only by dumping both catalogues and diffing
 * them, which is what this test now does on every run.
 *
 * Builds two scratch databases next to the configured one, so it needs a
 * Postgres but touches nothing that matters.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import pg from "pg";

import { cfg } from "../config.js";
import { errorMessage } from "@sightline/shared";

const HAS_INFRA = !process.env["SKIP_INTEGRATION"];

const MIGRATIONS = fileURLToPath(new URL("../../drizzle", import.meta.url));
const LEGACY_SQL = fileURLToPath(new URL("./legacySchema.sql", import.meta.url));

const ADOPTED = "sightline_adoption_from_legacy";
const FRESH = "sightline_adoption_from_scratch";

/** The configured connection, pointed at a different database on the same server. */
function urlFor(database: string): string {
  const url = new URL(cfg.DATABASE_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

/**
 * Everything that defines the shape of the database.
 *
 * Constraint *names* are included deliberately. They are what the next
 * migration will have to name to drop or alter something, so two databases
 * whose constraints differ only by name are not interchangeable — and a name
 * is exactly what the original bug got wrong.
 */
const CATALOGUE = sql`
  SELECT 'col|' || table_name || '|' || column_name || '|' || data_type || '|' ||
         is_nullable || '|' || coalesce(column_default, '-') AS line
    FROM information_schema.columns WHERE table_schema = 'public'
  UNION ALL
  SELECT 'idx|' || tablename || '|' || indexdef FROM pg_indexes WHERE schemaname = 'public'
  UNION ALL
  SELECT 'con|' || conrelid::regclass::text || '|' || conname || '|' || pg_get_constraintdef(oid)
    FROM pg_constraint WHERE connamespace = 'public'::regnamespace
  ORDER BY 1
`;

let admin: pg.Pool;
let available = false;
let skipReason: string | null = null;
let adopted: string[] = [];
let fresh: string[] = [];

async function catalogueOf(database: string, before?: (pool: pg.Pool) => Promise<void>) {
  const pool = new pg.Pool({ connectionString: urlFor(database) });
  try {
    if (before) await before(pool);
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS });
    const { rows } = await drizzle(pool).execute(CATALOGUE);
    return rows.map((r) => String((r as { line: string }).line));
  } finally {
    await pool.end();
  }
}

beforeAll(async () => {
  admin = new pg.Pool({ connectionString: urlFor("postgres") });
  try {
    await admin.query("SELECT 1");
  } catch (err) {
    skipReason = `Postgres was not reachable: ${errorMessage(err)}`;
    return;
  }

  for (const name of [ADOPTED, FRESH]) {
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.query(`CREATE DATABASE ${name}`);
  }

  const legacy = await readFile(LEGACY_SQL, "utf8");
  // One database is built the old way and then migrated; the other is migrated
  // from empty. Same migration, two starting points.
  adopted = await catalogueOf(ADOPTED, async (pool) => {
    await pool.query(legacy);
  });
  fresh = await catalogueOf(FRESH);
  available = true;
}, 120_000);

afterAll(async () => {
  if (admin) {
    for (const name of [ADOPTED, FRESH]) {
      await admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {});
    }
    await admin.end();
  }
});

describe.runIf(HAS_INFRA)("adopting a database built by the pre-ORM schema", () => {
  it("has something to compare", () => {
    if (!available) return;
    expect(skipReason).toBeNull();
    // Without this, a query that returned nothing would make the comparison
    // below pass by comparing two empty lists — which is how the bug this test
    // exists for stayed invisible in the first place.
    expect(fresh.length, "the catalogue query returned nothing").toBeGreaterThan(50);
    expect(fresh.some((l) => l.startsWith("con|") && l.includes("FOREIGN KEY"))).toBe(true);
  });

  it("produces exactly the schema a fresh database gets", () => {
    if (!available) return;
    const onlyAdopted = adopted.filter((l) => !fresh.includes(l));
    const onlyFresh = fresh.filter((l) => !adopted.includes(l));
    expect(
      { onlyAdopted, onlyFresh },
      "a migrated database and a new one disagree. Left over from the old schema, or " +
        "missing from it — either way the baseline migration's adoption block in " +
        "drizzle/0000_*.sql needs to account for it.",
    ).toEqual({ onlyAdopted: [], onlyFresh: [] });
  });

  it("does not leave a second copy of any constraint", () => {
    if (!available) return;
    // The specific failure that prompted all of this: constraints identical in
    // everything but name, so `ADD CONSTRAINT` saw no clash and added another.
    const definitions = adopted
      .filter((l) => l.startsWith("con|"))
      .map((l) => {
        const [, table, , ...rest] = l.split("|");
        return `${table}|${rest.join("|")}`;
      });
    const duplicates = definitions.filter((d, i) => definitions.indexOf(d) !== i);
    expect(
      duplicates,
      "these constraints exist twice on the migrated database under different names, " +
        "so every write checks them twice. The adoption block must rename the old one " +
        "rather than add a new one.",
    ).toEqual([]);
  });
});
