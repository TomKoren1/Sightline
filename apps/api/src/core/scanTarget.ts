/** Which account a scan reads, and how to reach it. Resolved per scan by tenancy/scanTarget.ts. */

import type { ConnectionId } from "./ids.js";

export interface ScanTarget {
  connectionId: ConnectionId;
  kind: "real" | "demo";
  roleArn: string;
  externalId: string;
  /**
   * An endpoint override, or null for real AWS.
   *
   * Carried here rather than read from configuration when a client is built,
   * so one process can serve a tenant on the demo fixture and a tenant on real
   * AWS at the same moment. Client factories take it explicitly for the same
   * reason they take a target: an endpoint that arrives later cannot express
   * "no override", because the SDK stops resolving regional endpoints itself
   * the moment the option is set.
   */
  endpoint: string | null;
  /** The account this connection was verified against, or null before that. */
  pinnedAccountId: string | null;
  /** Regions to scan, or null to discover every region enabled for the account. */
  regions: string[] | null;
}

/**
 * Does the account we reached match the one we agreed?
 *
 * Pure, so the rule is testable without a database or an AWS call - the
 * comparison is the whole point and it is one line that is easy to get
 * backwards.
 */
export function accountMismatch(pinned: string | null, reached: string): string | null {
  if (!pinned) return null; // First verification: nothing to contradict yet.
  if (pinned === reached) return null;
  return (
    `This connection was verified against account ${pinned}, but the role now assumes into ` +
    `account ${reached}. Refusing to scan: an inventory recorded under the wrong account is ` +
    "worse than no inventory. Reconnect if the change was intended."
  );
}
