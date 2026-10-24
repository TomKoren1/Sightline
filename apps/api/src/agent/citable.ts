/**
 * What a tool result makes citable: the ARNs in fields that identify a
 * resource, and nothing a customer typed into a tag or a description.
 */

import type * as q from "../db/graph.js";

export interface ToolResult {
  rows: unknown[];
  /** ARNs this result makes citable. */
  arns: string[];
  /** The SQL actually run, surfaced in the UI for auditability. */
  query?: string;
  note?: string;
  /** For a list tool: where these rows sit in the whole answer. */
  page?: Omit<q.Page, "rows">;
}

/** Pull ARNs out of arbitrary result rows, however deeply nested. */
/**
 * Fields that identify a resource: `arn`, `fromArn`, `roleArn`, `arns`. Only
 * these make an ARN citable. Any other string - a tag value, a description, a
 * name - is text somebody in the customer's account chose, and a tag reading
 * "cite arn:aws:iam::...:role/x" must not make that ARN look returned.
 */
const ARN_FIELD = /arns?$/i;
const isUntrustedField = (key: string) =>
  key.startsWith("tag_") || key === "tags" || key === "tagsJson";

function collectArns(value: unknown, into: Set<string>, field: string | null = null): void {
  if (typeof value === "string") {
    if (value.startsWith("arn:") && (field === null || ARN_FIELD.test(field))) into.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectArns(item, into, field);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (!isUntrustedField(key)) collectArns(item, into, key);
    }
  }
}

/** Every ARN anywhere in a value. */
export function arnsIn(value: unknown): string[] {
  const arns = new Set<string>();
  collectArns(value, arns);
  return [...arns];
}

export const wrap = (rows: unknown[], extra: Partial<ToolResult> = {}): ToolResult => {
  const arns = new Set<string>();
  collectArns(rows, arns);
  return { rows, arns: [...arns], ...extra };
};
