/**
 * The guard on `inventory_sql`, the agent's escape hatch for questions the
 * curated tools cannot express.
 *
 * The statement is parsed, not pattern-matched: one `SELECT`, reading only the
 * two views the tool defines (`resources`, `relationships`) or CTEs it names
 * itself, calling only functions on an allowlist. What it cannot do is decided
 * by what is allowed rather than by a list of what is not, because the
 * dangerous part of SQL is large and the useful part is small.
 *
 * Behind this, the query runs as the tenant under row-level security, inside a
 * read-only transaction with a statement timeout, against views pinned to one
 * scan - so a guard bug costs a refused or empty answer, not another
 * account's data.
 */

// The PostgreSQL grammar alone: the package's default entry carries every
// dialect it supports, 89 MB installed, for the one this guard parses.
import pkg from "node-sql-parser/build/postgresql.js";

const { Parser } = pkg;
const parser = new Parser();
const OPTIONS = { database: "PostgresQL" };

/** The views the tool provides. Nothing else in the database is reachable. */
export const INVENTORY_VIEWS = ["resources", "relationships", "policy_documents"] as const;

/**
 * Functions a read over two JSONB-bearing views reasonably needs. Notably
 * absent: anything `pg_*`, `set_config`, `current_setting`, `dblink`, `lo_*`,
 * `query_to_xml` and the rest of the ways to reach outside the views.
 */
const FUNCTIONS = new Set([
  "count",
  "sum",
  "avg",
  "min",
  "max",
  "bool_and",
  "bool_or",
  "array_agg",
  "string_agg",
  "jsonb_agg",
  "json_agg",
  "jsonb_object_agg",
  "lower",
  "upper",
  "length",
  "position",
  "strpos",
  "substring",
  "substr",
  "trim",
  "ltrim",
  "rtrim",
  "replace",
  "split_part",
  "concat",
  "concat_ws",
  "left",
  "right",
  "starts_with",
  "coalesce",
  "nullif",
  "greatest",
  "least",
  "abs",
  "round",
  "floor",
  "ceil",
  "jsonb_array_elements",
  "jsonb_array_elements_text",
  "jsonb_array_length",
  "jsonb_each",
  "jsonb_each_text",
  "jsonb_object_keys",
  "jsonb_typeof",
  "jsonb_build_object",
  "jsonb_build_array",
  "jsonb_extract_path",
  "jsonb_extract_path_text",
  "jsonb_path_query",
  "jsonb_path_exists",
  "to_jsonb",
  "cardinality",
  "array_length",
  "unnest",
  "row_number",
  "rank",
  "dense_rank",
]);

export type GuardCause = "parse" | "multiple" | "not_select" | "parameter" | "table" | "function";

export type GuardResult = { ok: true } | { ok: false; reason: string; cause: GuardCause };

function functionName(node: Record<string, unknown>): string | null {
  const name = node["name"];
  if (typeof name === "string") return name.toLowerCase();
  if (name && typeof name === "object") {
    const parts = (name as { name?: { value?: unknown }[] }).name;
    if (Array.isArray(parts)) {
      return parts
        .map((p) => (typeof p.value === "string" ? p.value : ""))
        .join(".")
        .toLowerCase();
    }
  }
  return null;
}

/** Every function or aggregate the statement calls, by lower-case name. */
function calledFunctions(node: unknown, into: Set<string>): void {
  if (Array.isArray(node)) {
    for (const child of node) calledFunctions(child, into);
    return;
  }
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  if (obj["type"] === "function" || obj["type"] === "aggr_func") {
    const name = functionName(obj);
    if (name) into.add(name);
  }
  for (const value of Object.values(obj)) calledFunctions(value, into);
}

export function assertSafeInventorySql(statement: string): GuardResult {
  const text = statement.trim().replace(/;\s*$/, "");
  if (/\$\d/.test(text)) {
    return {
      ok: false,
      cause: "parameter",
      reason: "Write literal values; bind parameters are not supported.",
    };
  }

  let ast: unknown;
  let tables: string[];
  try {
    ast = parser.astify(text, OPTIONS);
    tables = parser.tableList(text, OPTIONS);
  } catch (err) {
    const detail = err instanceof Error ? err.message.split("\n")[0] : "";
    return { ok: false, cause: "parse", reason: `Could not parse the query. ${detail}`.trim() };
  }

  if (Array.isArray(ast)) {
    if (ast.length !== 1)
      return { ok: false, cause: "multiple", reason: "Send exactly one statement." };
    ast = ast[0];
  }
  const root = ast as { type?: string; with?: { name?: { value?: string } | string }[] | null };
  if (root.type !== "select") {
    return {
      ok: false,
      cause: "not_select",
      reason: "Only SELECT is allowed; this tool cannot change anything.",
    };
  }

  const ctes = new Set(
    (root.with ?? []).map((w) =>
      String(typeof w.name === "string" ? w.name : (w.name?.value ?? "")).toLowerCase(),
    ),
  );
  for (const entry of tables) {
    const [, schema, name] = entry.split("::");
    const table = (name ?? "").toLowerCase();
    const allowed = (INVENTORY_VIEWS as readonly string[]).includes(table) || ctes.has(table);
    if (schema !== "null" || !allowed) {
      return {
        ok: false,
        cause: "table",
        reason: `Only the views ${INVENTORY_VIEWS.join(", ")} can be read; "${schema === "null" ? table : `${schema}.${table}`}" is not one of them.`,
      };
    }
  }

  const functions = new Set<string>();
  calledFunctions(ast, functions);
  const refused = [...functions].filter((f) => !FUNCTIONS.has(f));
  if (refused.length > 0) {
    return {
      ok: false,
      cause: "function",
      reason: `Function${refused.length > 1 ? "s" : ""} not allowed: ${refused.join(", ")}.`,
    };
  }

  return { ok: true };
}
