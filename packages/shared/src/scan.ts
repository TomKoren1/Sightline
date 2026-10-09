/** Scan lifecycle types, shared between the scanner, the API and the UI. */

import type { Resource, Relationship } from "./model.js";

/** AWS services the scanner knows how to enumerate. */
export const SCANNABLE_SERVICES = ["ec2", "vpc", "s3", "iam", "rds", "lambda"] as const;
export type ScannableService = (typeof SCANNABLE_SERVICES)[number];

/** Services whose resources are global; scanned once, not once per region. */
export const GLOBAL_SERVICES: ReadonlySet<ScannableService> = new Set(["iam", "s3"]);

export type ScanUnitStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

/**
 * One (service, region) pair - the unit of partial failure.
 *
 * A scan is a set of these, and each one succeeds or fails independently. A
 * throttled RDS call in eu-west-1 must never invalidate a clean EC2 inventory
 * in us-east-1, because a half-scan that tells you which half is missing is far
 * more useful than an error page.
 */
export interface ScanUnit {
  service: ScannableService;
  /** `null` for global services. */
  region: string | null;
  status: ScanUnitStatus;
  resourceCount: number;
  apiCalls: number;
  durationMs: number;
  /** Present when status is "failed". */
  error?: string;
  /** AWS error code, e.g. `UnauthorizedOperation`, `Throttling`. */
  errorCode?: string;
  startedAt?: string;
  finishedAt?: string;
}

export type ScanStatus = "running" | "succeeded" | "partial" | "failed";

export interface ScanRun {
  id: string;
  accountId: string;
  status: ScanStatus;
  startedAt: string;
  finishedAt: string | null;
  /** Regions the scan targeted. */
  regions: string[];
  units: ScanUnit[];
  resourceCount: number;
  relationshipCount: number;
  /** Set when the whole scan aborted (e.g. AssumeRole failed). */
  error?: string;
}

/** Result of a completed scan, before persistence. */
export interface ScanResult {
  accountId: string;
  regions: string[];
  units: ScanUnit[];
  resources: Resource[];
  relationships: Relationship[];
}

/** Roll a set of unit outcomes into an overall scan status. */
export function rollUpStatus(units: ScanUnit[]): ScanStatus {
  const done = units.filter((u) => u.status !== "pending" && u.status !== "running");
  if (done.length === 0) return "running";
  const failed = done.filter((u) => u.status === "failed");
  if (failed.length === 0) return "succeeded";
  if (failed.length === done.length) return "failed";
  return "partial";
}

/** Server-sent event payloads emitted while a scan runs. */
export type ScanEvent =
  | { type: "scan.started"; scanId: string; regions: string[]; units: ScanUnit[] }
  | { type: "unit.started"; scanId: string; service: string; region: string | null }
  | { type: "unit.finished"; scanId: string; unit: ScanUnit }
  | { type: "scan.progress"; scanId: string; completed: number; total: number }
  | { type: "scan.finished"; scanId: string; run: ScanRun }
  | { type: "scan.failed"; scanId: string; error: string };

/** A resource-level difference between two scans. */
export interface ResourceDiff {
  arn: string;
  kind: string;
  name: string;
  change: "added" | "removed" | "modified";
  /** For "modified": the fields that differ, with both values. */
  changedFields?: { field: string; before: unknown; after: unknown }[];
}

export interface ScanDiff {
  fromScanId: string;
  toScanId: string;
  fromScanAt: string;
  toScanAt: string;
  added: ResourceDiff[];
  removed: ResourceDiff[];
  modified: ResourceDiff[];
}

/**
 * Field changes that are a security event rather than bookkeeping.
 *
 * An instance gaining a public IP and an instance gaining a tag are both
 * "modified", and only one of them is worth interrupting someone for. This
 * lives in the shared model rather than in the component that renders it,
 * because it is domain knowledge — the same judgement an alerting rule or a
 * digest email would need — and because here it can be tested.
 */
export const SIGNIFICANT_CHANGE_FIELDS: ReadonlySet<string> = new Set([
  // Derived security verdicts flipping is the strongest signal there is.
  "derived.isPublic",
  "derived.isAdmin",
  "derived.isIdle",
  // Exposure
  "publiclyAccessible",
  "publicIpAddress",
  "isPublic",
  // Network reachability
  "ingress",
  "ingressRuleCount",
  "securityGroupIds",
  // Access control
  "policy",
  "policyIsPublic",
  "publicAccessBlock",
  "attachedPolicies",
  "inlinePolicies",
  "trustPolicy",
  "roleArn",
  // Lifecycle, which changes cost and availability
  "state",
  "status",
]);

/** Does this diff contain a change worth drawing attention to? */
export function hasSignificantChange(diff: ResourceDiff): boolean {
  return (diff.changedFields ?? []).some((f) => SIGNIFICANT_CHANGE_FIELDS.has(f.field));
}

/**
 * Order changed fields so the ones that matter come first.
 *
 * Returns a new array; the input is left alone because callers may be rendering
 * from React state.
 */
export function sortFieldsBySignificance<T extends { field: string }>(fields: T[]): T[] {
  return [...fields].sort(
    (a, b) =>
      Number(SIGNIFICANT_CHANGE_FIELDS.has(b.field)) -
      Number(SIGNIFICANT_CHANGE_FIELDS.has(a.field)),
  );
}
