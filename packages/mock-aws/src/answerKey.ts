/**
 * The answer key, and nothing that can change an account.
 *
 * The API grades the demo connection against these at run time, so they are
 * importable on their own: the seeding and drift code beside them hold AWS
 * clients that write, and have no business in the running service.
 */

export * from "./topology.js";

/**
 * Resources that exist only after drift has been applied.
 *
 * Used to detect a drifted account. The ground-truth checks describe the
 * pristine fixture, so once drift has been applied some of them are *supposed*
 * to fail — a bucket really did become public. Without a way to tell the two
 * situations apart, the Trust panel would report a correct system as broken,
 * which is worse than not offering the checks at all.
 */
export const DRIFT_MARKER_RESOURCES = ["new-unattached-vol"] as const;

/**
 * The ground-truth checks drift is *expected* to break, and why.
 *
 * Edit together with `drift.ts`: a mutation with no entry here reads as an
 * unexplained failure on the Trust panel, and an entry left behind excuses a
 * genuine regression while the account happens to be drifted.
 */
export const DRIFT_EXPECTED_CHECK_FAILURES: Readonly<Record<string, string>> = {
  "public-buckets":
    "northwind-logs-archive gains a wildcard policy with no public access block, so it is genuinely public and correctly flagged.",
  "idle-resources":
    "new-unattached-vol is created attached to nothing, and prod-web-2 is stopped; both are correctly billable-but-idle.",
};
