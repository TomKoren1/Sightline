/**
 * Does a resource policy let anyone at all act on the resource?
 *
 * The same question for a queue, a topic, a secret and a key: an Allow to
 * `Principal: "*"` (or `{"AWS": "*"}`) that no real condition narrows. SNS's
 * default policy grants `{"AWS": "*"}` and is safe, because it is conditioned
 * on the topic's owner; reading the principal alone gets that wrong.
 */

import { conditionRestricts } from "./policy.js";

interface Statement {
  Sid?: string;
  Effect?: string;
  Principal?: unknown;
  Action?: string | string[];
  Condition?: Record<string, unknown>;
}

/** Policy fields are a string or a list of strings; anything else matches nothing. */
const asArray = (v: unknown): string[] =>
  (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === "string");

function isEveryone(principal: unknown): boolean {
  if (principal === "*") return true;
  if (principal && typeof principal === "object") {
    return asArray((principal as { AWS?: unknown }).AWS).includes("*");
  }
  return false;
}

/** The actions anyone may take, and the statement granting them; null if none. */
export function publicGrant(policyJson: string | null): { actions: string[]; sid?: string } | null {
  if (!policyJson) return null;
  let statements: Statement[];
  try {
    const doc = JSON.parse(policyJson) as { Statement?: Statement | Statement[] };
    statements = Array.isArray(doc.Statement)
      ? doc.Statement
      : doc.Statement
        ? [doc.Statement]
        : [];
  } catch {
    return null;
  }
  for (const stmt of statements) {
    if (stmt.Effect !== "Allow" || !isEveryone(stmt.Principal)) continue;
    if (conditionRestricts(stmt.Condition)) continue;
    return { actions: asArray(stmt.Action), ...(stmt.Sid ? { sid: stmt.Sid } : {}) };
  }
  return null;
}

const NOUN: Record<string, string> = {
  SqsQueue: "queue",
  SnsTopic: "topic",
  Secret: "secret",
  KmsKey: "key",
};

/** Kinds whose exposure is decided by a resource policy. */
export const POLICY_KINDS = new Set(Object.keys(NOUN));

export function resourcePolicyVerdict(
  kind: string,
  policyJson: string | null,
): { isPublic: boolean; reason: string } {
  const grant = publicGrant(policyJson);
  const noun = NOUN[kind] ?? "resource";
  if (!grant) {
    return {
      isPublic: false,
      reason: policyJson
        ? `Its policy grants nothing to everyone without a condition that narrows it`
        : `It has no resource policy, so only this account's own principals can use the ${noun}`,
    };
  }
  const where = grant.sid ? ` (statement "${grant.sid}")` : "";
  return {
    isPublic: true,
    reason: `Its policy allows anyone to ${grant.actions.join(", ") || "act on it"}${where}: Principal "*" with no condition that narrows it`,
  };
}
