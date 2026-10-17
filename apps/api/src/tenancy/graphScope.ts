/**
 * From "whose data" to "which graph".
 *
 * The graph a connection reads is its latest projected scan, which lives in
 * Postgres - so every graph read begins with one indexed lookup. That is the
 * cost of write-then-flip, and it buys a projection that can never be read
 * half-built.
 *
 * `null` means this connection has no projected scan yet, which is the normal
 * state of a connection nobody has scanned. It is not an error, and callers
 * render an empty graph from it rather than a failure.
 */

import { currentScanId } from "../db/repository.js";
import type { GraphScope } from "../db/neo4j.js";
import type { Scope } from "./scope.js";

export async function graphScopeFor(scope: Scope): Promise<GraphScope | null> {
  const scanId = await currentScanId(scope);
  return scanId ? { tenantId: scope.tenantId, scanId } : null;
}

/**
 * The graph, or a refusal naming what is missing.
 *
 * For callers where an empty answer would be a lie rather than an empty state -
 * the agent, which would otherwise tell a customer their account contains
 * nothing.
 */
export async function requireGraphScope(scope: Scope): Promise<GraphScope> {
  const graph = await graphScopeFor(scope);
  if (!graph) {
    throw new Error(
      "This account has not been scanned yet, so there is no graph to query. Run a scan first.",
    );
  }
  return graph;
}
