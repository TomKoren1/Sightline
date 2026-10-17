/**
 * Serialises the test files that exercise the real `scan_jobs` table.
 *
 * Test-only, and shared rather than copied into each of the two files needing
 * it. `claimNextJob` takes the oldest queued job across every tenant, which is
 * correct - one worker serves everybody - and makes any test that claims
 * inherently exclusive: scoping deletes per tenant is not enough, because one
 * file's claim takes another's seeded job and leaves it running for ever. Both
 * then fail intermittently, and did.
 *
 * Vitest parallelises test *files*, so ordering within a file cannot fix it.
 * Session-scoped, so it holds a connection of its own: a pooled one would be
 * handed back between statements and the lock released with it.
 */

import pg from "pg";

import { cfg } from "../config.js";

/** Nothing to release: the database was unreachable, so no lock was taken. */
const releaseNothing = (): Promise<void> => Promise.resolve();

/** A close that fails during teardown must not fail the teardown. */
const ignore = (): void => undefined;

/**
 * Arbitrary, and shared by every file that touches the queue.
 *
 * `pg_advisory_lock` takes a 64-bit key with no namespacing, so the only thing
 * that makes this safe is that it is a constant in one place.
 */
const QUEUE_TEST_LOCK = 0x51_4e_45_55; // "QNEU"

/**
 * Take the lock, returning the release.
 *
 * Returns a no-op release when the database is unreachable, so a suite that
 * skips for lack of Postgres does not fail in its teardown instead.
 */
export async function lockQueueForTest(): Promise<() => Promise<void>> {
  let client: pg.Client;
  try {
    client = new pg.Client({ connectionString: cfg.DATABASE_URL });
    await client.connect();
  } catch {
    return releaseNothing;
  }

  await client.query("SELECT pg_advisory_lock($1)", [QUEUE_TEST_LOCK]);

  return async () => {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [QUEUE_TEST_LOCK]);
    } finally {
      // Ending the session would release the lock anyway; the explicit unlock
      // above is for the case where this client is somehow reused.
      await client.end().catch(ignore);
    }
  };
}
