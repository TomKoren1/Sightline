/**
 * Serialises the test files that exercise the real `scan_jobs` table.
 *
 * Test-only, and here rather than inside one of the test files because two of
 * them need the same lock and a copy in each is a copy that drifts.
 *
 * ## Why a lock and not better cleanup
 *
 * `claimNextJob` takes the oldest queued job **across every tenant**, which is
 * correct - one worker serves everybody - and makes any test that claims
 * inherently exclusive. Scoping each test's deletes to its own tenant is not
 * enough: `queue.test.ts` claiming would still take a job `progress.test.ts`
 * had seeded, turning it `running` and locked by a worker that never finishes.
 * Both files then fail, intermittently, depending on which worker got there
 * first - and they did: five queue tests passed alone and failed in the full
 * suite.
 *
 * Vitest runs test *files* in parallel workers, so no amount of ordering within
 * a file fixes this. An advisory lock is the mechanism the shared resource
 * already provides: whoever holds it runs, the other waits in `beforeAll`.
 *
 * Session-scoped, so it needs a connection of its own held for the file's
 * lifetime - a pooled one would be handed back between statements and the lock
 * released with it.
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
