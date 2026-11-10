/**
 * The boot-time bootstrap fills a role ARN the migration left null.
 *
 * Migration 0001 creates the real connection with a null `role_arn` for `.env`
 * to fill on the next boot. The statement meant to do that compared with `<>`,
 * and `null <> 'arn:...'` is null rather than true - so the row needing the
 * fill was the one row the predicate could not see, and setup ended on "has no
 * role yet" however often the API restarted.
 *
 * Both halves are asserted, because the obvious fix breaks the second: the null
 * is filled, *and* an unchanged boot still writes nothing. Needs Postgres.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";

import { LOCAL_REAL_CONNECTION_ID } from "./local.js";

const HAS_INFRA = !process.env["SKIP_INTEGRATION"];

const ORIGINAL_ENV = { ...process.env };

/** Well-formed, and not the placeholder `realAccountConfigured()` rejects. */
const TEST_ARN = "arn:aws:iam::672299759593:role/SightlineReadOnlyRole";

type Row = {
  role_arn: string | null;
  account_id: string | null;
  status: string;
  updated_at: string;
} & Record<string, unknown>;

let available = false;
let db: typeof import("../db/postgres.js").system;
let ensureLocalTenant: typeof import("./local.js").ensureLocalTenant;

/**
 * What the row held before this file ran, restored afterwards.
 *
 * These ids are fixed, so unlike the tenant tests beside this one there is no
 * random fixture confining the damage: a developer running the suite against
 * their own database has a real "My AWS" connection at this id. The whole row
 * goes out and comes back through `jsonb`, so nothing is left behind - not a
 * repointed ARN, and not a verified connection knocked back to pending.
 */
let saved: unknown;

/**
 * Raw SQL rather than the Drizzle schema: the modules under test are loaded
 * through `vi.resetModules()`, and a second copy of the schema would mean two
 * module graphs disagreeing about one table.
 */
async function connectionRow(): Promise<Row | undefined> {
  const { rows } = await db.execute<Row>(
    sql`SELECT role_arn, account_id, status, updated_at FROM connections
        WHERE id = ${LOCAL_REAL_CONNECTION_ID}`,
  );
  return rows[0];
}

/**
 * The row exactly as the migration leaves it: created, and waiting for `.env`.
 *
 * Reached by letting the bootstrap insert it and then nulling the column,
 * rather than by hand-copying the migration's INSERT, so this stays correct
 * when the row gains a column later.
 */
async function asMigrationLeftIt(): Promise<void> {
  await db.execute(
    sql`UPDATE connections SET role_arn = NULL, account_id = NULL, status = 'pending'
        WHERE id = ${LOCAL_REAL_CONNECTION_ID}`,
  );
}

beforeAll(async () => {
  if (!HAS_INFRA) return;

  // Configuration is parsed once at import, so the environment has to be in
  // place before the modules are. The pattern `core/hostedMode.test.ts` uses.
  process.env = { ...ORIGINAL_ENV, AWS_MODE: "real", AWS_TARGET_ROLE_ARN: TEST_ARN };
  delete process.env["DEPLOYMENT_MODE"];
  vi.resetModules();

  db = (await import("../db/postgres.js")).system;
  ensureLocalTenant = (await import("./local.js")).ensureLocalTenant;

  try {
    await db.execute(sql`SELECT 1`);
  } catch {
    return;
  }

  const { rows } = await db.execute<{ row: unknown }>(
    sql`SELECT to_jsonb(c) AS row FROM connections c WHERE id = ${LOCAL_REAL_CONNECTION_ID}`,
  );
  saved = rows[0]?.row ?? null;
  available = true;
});

afterAll(async () => {
  if (available) {
    await db.execute(sql`DELETE FROM connections WHERE id = ${LOCAL_REAL_CONNECTION_ID}`);
    if (saved !== null) {
      await db.execute(
        sql`INSERT INTO connections
            SELECT * FROM jsonb_populate_record(NULL::connections, ${JSON.stringify(saved)}::jsonb)`,
      );
    }
  }
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe.runIf(HAS_INFRA)("the local bootstrap", () => {
  it("fills a role ARN the migration left null", async () => {
    expect(available, "Postgres is not reachable, so none of this was checked").toBe(true);
    if (!available) return;

    await ensureLocalTenant();
    await asMigrationLeftIt();
    expect((await connectionRow())?.role_arn).toBeNull();

    await ensureLocalTenant();

    const row = await connectionRow();
    expect(row?.role_arn).toBe(TEST_ARN);
    // Filled, not thereby trusted: the ARN is a claim until the role is assumed.
    expect(row?.status).toBe("pending");
  });

  it("writes nothing on a boot that changes nothing", async () => {
    if (!available) return;

    await ensureLocalTenant();
    const before = await connectionRow();

    await ensureLocalTenant();

    // `updated_at` moving is how an unconditional update would show itself,
    // and with it the reset of `status` and `account_id` that rides along.
    expect((await connectionRow())?.updated_at).toEqual(before?.updated_at);
  });
});
