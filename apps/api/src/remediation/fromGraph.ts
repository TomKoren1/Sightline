/**
 * Rebuilding a remediation input from a graph row.
 *
 * Neo4j properties must be primitives, so the projection stores nested values
 * as JSON strings (see `db/neo4j.ts`). This is the only place that knows it
 * does, which keeps `remediation.ts` a pure function of a plain object.
 *
 * Parsing is best-effort: an unparseable property is dropped rather than thrown
 * on, so a malformed value produces no remediation instead of a 500 that takes
 * out the whole detail panel.
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
