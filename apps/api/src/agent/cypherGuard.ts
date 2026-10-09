/**
 * The guard on the agent's raw-Cypher escape hatch.
 *
 * The curated tools cannot express a mutation, so they need no guard. This
 * exists only for `graph_query`, which lets the model ask something nobody
 * anticipated. It is the second of two layers - the query also runs inside a
 * Neo4j read transaction, which rejects writes on its own (see
 * `readQuery`). Neither layer is trusted alone.
 *
 * The approach is an allowlist of opening clauses plus a denylist of write
 * keywords, applied after string literals and comments have been stripped so
 * that a node named "DELETE ME" cannot trip it and, more importantly, a write
 * cannot hide inside a string.
 *
 * This is a lexical check, not a parser. It is deliberately strict: a query it
 * wrongly rejects costs the user one retry, while one it wrongly accepts
 * breaks the one hard rule.
 */

/** Clauses that mutate the graph or the database. */
const FORBIDDEN_KEYWORDS = [
  "CREATE",
  "MERGE",
  "DELETE",
  "DETACH",
  "SET",
  "REMOVE",
  "DROP",
  "FOREACH",
  "LOAD",
  "CALL",
  "USE",
  "ALTER",
  "GRANT",
  "DENY",
  "REVOKE",
  "START",
  "TERMINATE",
];

/** A read query can only begin with one of these. */
const ALLOWED_OPENINGS = ["MATCH", "OPTIONAL", "WITH", "UNWIND", "RETURN", "PROFILE", "EXPLAIN"];

export interface GuardResult {
  ok: boolean;
  reason?: string;
}

/**
 * Remove comments and string literals.
 *
 * Both are places a forbidden keyword can appear harmlessly - and a place an
 * attacker would try to hide one - so the check runs on what is left.
 */
export function stripLiteralsAndComments(cypher: string): string {
  let out = "";
  let i = 0;
  while (i < cypher.length) {
    const ch = cypher[i]!;
    const next = cypher[i + 1];

    if (ch === "/" && next === "/") {
      while (i < cypher.length && cypher[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < cypher.length && !(cypher[i] === "*" && cypher[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      i++;
      while (i < cypher.length && cypher[i] !== quote) {
        if (cypher[i] === "\\") i++;
        i++;
      }
      i++;
      // Replaced with a space so adjacent tokens do not fuse together.
      out += " ";
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

export function assertReadOnlyCypher(cypher: string): GuardResult {
  const trimmed = cypher.trim();
  if (trimmed.length === 0) return { ok: false, reason: "Query is empty" };
  if (trimmed.length > 4000) {
    return { ok: false, reason: "Query is too long; use one of the curated tools instead" };
  }

  const stripped = stripLiteralsAndComments(trimmed);

  // Multiple statements would let a read be followed by a write.
  const withoutTrailing = stripped.replace(/;\s*$/, "");
  if (withoutTrailing.includes(";")) {
    return { ok: false, reason: "Only a single statement is allowed" };
  }

  const upper = withoutTrailing.toUpperCase();

  const firstWord = upper.trimStart().split(/[\s(]+/)[0] ?? "";
  if (!ALLOWED_OPENINGS.includes(firstWord)) {
    return {
      ok: false,
      reason: `Query must start with one of ${ALLOWED_OPENINGS.join(", ")}, but starts with "${firstWord}"`,
    };
  }

  for (const keyword of FORBIDDEN_KEYWORDS) {
    // Word boundaries, so `RETURN r.created_at` and a variable named `setting`
    // are not mistaken for CREATE and SET.
    if (new RegExp(`\\b${keyword}\\b`).test(upper)) {
      return {
        ok: false,
        reason: `Query contains the forbidden clause "${keyword}". The agent has read-only access and cannot modify the graph.`,
      };
    }
  }

  return { ok: true };
}
