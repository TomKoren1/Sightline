/**
 * IAM policy document evaluation.
 *
 * Deliberately small and deliberately conservative. This is not a full IAM
 * evaluator - it does not model permission boundaries, service control
 * policies, session policies, or resource-based policy interactions. What it
 * does do is answer one narrow question accurately: does this document grant
 * unrestricted access?
 *
 * Being explicit about the limit matters more than being clever. An answer of
 * "this role is an administrator" must be right; an answer of "this role is
 * not" is scoped to the policies we could read.
 */

import type { PolicyDocument } from "../collectors/iam.js";

const asArray = (v: string | string[] | undefined): string[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];

/** `*` or `service:*` matches everything under it. */
function grantsAllActions(actions: string[]): boolean {
  return actions.some((a) => a === "*");
}

function grantsAllResources(resources: string[]): boolean {
  return resources.some((r) => r === "*");
}

export interface AdminVerdict {
  isAdmin: boolean;
  /** Human-readable evidence, always populated. */
  reason: string;
  /** Which policy produced the verdict, for the UI and for citations. */
  via?: { policyName: string; kind: "managed" | "inline"; sid?: string };
}

export interface PolicyRef {
  policyName: string;
  kind: "managed" | "inline";
  document: PolicyDocument | null;
}

/**
 * Does this document contain an unconditional `Allow` of `*` on `*`?
 *
 * Statements carrying a `Condition` are not treated as admin grants: a
 * condition can restrict a statement to an IP range, an MFA session or a
 * specific tag, and calling that "administrator access" would produce false
 * positives on exactly the accounts that are being careful.
 */
export function documentGrantsAdmin(doc: PolicyDocument | null): { yes: boolean; sid?: string } {
  if (!doc?.Statement) return { yes: false };
  for (const stmt of doc.Statement) {
    if (stmt.Effect !== "Allow") continue;
    if (stmt.Condition && Object.keys(stmt.Condition).length > 0) continue;
    // NotAction inverts the match; treating it as admin needs different logic,
    // so it is explicitly out of scope rather than silently mishandled.
    if (stmt.NotAction) continue;
    const actions = asArray(stmt.Action);
    const resources = asArray(stmt.Resource);
    if (grantsAllActions(actions) && grantsAllResources(resources)) {
      return { yes: true, sid: stmt.Sid };
    }
  }
  return { yes: false };
}

/**
 * Decide whether a principal is effectively an administrator, given every
 * policy attached to it.
 */
export function evaluateAdmin(policies: PolicyRef[]): AdminVerdict {
  for (const policy of policies) {
    const { yes, sid } = documentGrantsAdmin(policy.document);
    if (yes) {
      const where = sid ? `statement "${sid}" of ` : "";
      return {
        isAdmin: true,
        reason: `Grants Action "*" on Resource "*" via ${where}the ${policy.kind} policy "${policy.policyName}"`,
        via: { policyName: policy.policyName, kind: policy.kind, ...(sid ? { sid } : {}) },
      };
    }
  }

  const unreadable = policies.filter((p) => p.document === null);
  if (unreadable.length > 0) {
    return {
      isAdmin: false,
      reason: `No unrestricted grant found in ${policies.length - unreadable.length} readable policies, but ${unreadable.length} could not be read (${unreadable.map((p) => p.policyName).join(", ")})`,
    };
  }

  return {
    isAdmin: false,
    reason:
      policies.length === 0
        ? "No policies attached"
        : `None of the ${policies.length} attached policies grants Action "*" on Resource "*"`,
  };
}
