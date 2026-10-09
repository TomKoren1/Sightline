/**
 * Rebuilding a remediation input from a graph row.
 *
 * Neo4j properties must be primitives or arrays of primitives, so the
 * projection stores nested values — a public access block, a list of ingress
 * rules, a set of attached policies — as JSON strings under the same key
 * (see `db/neo4j.ts`). The remediation generators need them back as objects.
 *
 * This is the seam where that reversal happens, and it is deliberately the only
 * place that knows the projection does it. `remediation.ts` stays a pure
 * function of a plain object, which is what makes it testable without a
 * database.
 *
 * Parsing is best-effort by design: a property that will not parse is dropped
 * rather than thrown on. A remediation generator that receives no ingress rules
 * produces no security-group remediation, which is the correct outcome —
 * whereas a 500 on a resource detail page because one property was malformed
 * would take out the whole panel for a finding the user is trying to read.
 */

import type { RemediationInput } from "./remediation.js";

/** Property keys the generators need as structured values rather than strings. */
const STRUCTURED_KEYS = [
  "publicAccessBlock",
  "ingress",
  "attachedPolicies",
  "inlinePolicies",
  "aclGrants",
] as const;

/** Derived-fact keys, promoted to top level by the projection. */
const DERIVED_KEYS = [
  "isPublic",
  "publicReason",
  "isUnprotected",
  "unprotectedReason",
  "isAdmin",
  "adminReason",
  "isIdle",
  "idleReason",
  "estimatedMonthlyCostUsd",
] as const;

function parseIfJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Malformed is treated as absent; see the note at the top of the file.
    return undefined;
  }
}

/** A row as `getResource` returns it. */
export interface GraphResourceRow {
  arn: string;
  kind: string;
  name: string;
  region: string | null;
  props?: Record<string, unknown>;
  incoming?: {
    type: string | null;
    arn: string | null;
    name: string | null;
    kind: string | null;
  }[];
  [key: string]: unknown;
}

/**
 * Relationship types that mean "this resource is in use by that one".
 *
 * Only these count towards the caution text. An `IN_REGION` edge says nothing
 * about whether detaching a policy will break something, and counting it would
 * make every resource look load-bearing.
 */
const USAGE_EDGES = new Set([
  "EXECUTES_AS",
  "HAS_INSTANCE_PROFILE",
  "PROVIDES_ROLE",
  "ATTACHED_TO",
]);

export function remediationInputFromGraph(row: GraphResourceRow): RemediationInput {
  const props = row.props ?? {};

  const properties: Record<string, unknown> = { ...props };
  for (const key of STRUCTURED_KEYS) {
    if (key in properties) {
      const parsed = parseIfJson(properties[key]);
      if (parsed === undefined) delete properties[key];
      else properties[key] = parsed;
    }
  }

  const derived: RemediationInput["derived"] = {};
  for (const key of DERIVED_KEYS) {
    const value = props[key];
    if (value !== undefined && value !== null) {
      (derived as Record<string, unknown>)[key] = value;
    }
  }

  const usedBy = (row.incoming ?? [])
    .filter((e) => e.type && USAGE_EDGES.has(e.type) && e.name && e.kind)
    .map((e) => ({ name: e.name!, kind: e.kind! }));

  return {
    arn: row.arn,
    kind: row.kind,
    name: row.name,
    region: row.region,
    properties,
    derived,
    ...(usedBy.length > 0 ? { usedBy } : {}),
  };
}
