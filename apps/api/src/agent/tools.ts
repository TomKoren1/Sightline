/**
 * The agent's tools.
 *
 * Each one wraps a curated query. The model chooses which to call
 * and with what arguments; it never writes the query, and none of these can
 * express a mutation - the read-only rule is enforced by construction
 * rather than by instruction.
 *
 * Descriptions matter more than they look. They are the only thing the model
 * sees when deciding what to call, so each says what the tool answers *and*
 * when to prefer it over a neighbour - most bad answers are a tool-choice
 * mistake, not a reasoning one.
 */

import * as q from "../db/graph.js";
import { isHosted } from "../core/config.js";
import { remediationInputFromGraph } from "../remediation/fromGraph.js";
import { remediationsFor } from "../remediation/remediation.js";
import type { GraphScope } from "../db/graph.js";
import { readOnlyAsTenant } from "../db/postgres.js";
import { listScans } from "../db/repository.js";
import { diffScans } from "../db/scanDiff.js";
import { asScanId } from "../core/ids.js";
import type { Scope } from "../core/scope.js";
import { agentRawQueryRefused } from "../observability/metrics.js";
import { assertSafeInventorySql } from "./sqlGuard.js";
import { wrap, type ToolResult } from "./citable.js";
import { AGENT_MAX_PAGE_ROWS, AGENT_PAGE_ROWS, RAW_QUERY_TOOL } from "./toolDefinitions.js";

/**
 * What a tool may read: one tenant, and one of their scans.
 *
 * Passed in rather than resolved here, so a tool cannot run without the caller
 * having decided whose graph it is reading.
 */
export interface ToolContext {
  scope: Scope;
  graph: GraphScope;
}

/**
 * Tools that answer a list question, and the finder each pages through. Their
 * results carry the true total and counts by kind and region, so "how many"
 * is answered by Postgres rather than by the model counting a truncated list.
 */
const PAGED: Record<string, q.FinderName> = {
  list_resources: "listResources",
  find_public_resources: "findPublicResources",
  find_admin_principals: "findAdminPrincipals",
  find_instances_in_public_subnets: "findInstancesInPublicSubnets",
  find_idle_resources: "findIdleResources",
  find_unprotected_buckets: "findUnprotectedBuckets",
  find_unused_access: "findUnusedAccess",
  find_open_security_groups: "findOpenSecurityGroups",
  find_cross_account_access: "findCrossAccountAccess",
  search_resources: "searchResources",
};

/**
 * Where the next page starts, bound to its scan: a cursor kept across a rescan
 * would otherwise page through a different estate at the same offsets.
 */
export const encodeCursor = (scanId: string, offset: number) =>
  Buffer.from(JSON.stringify({ s: scanId, o: offset })).toString("base64url");

function decodeCursor(value: unknown, scanId: string): number | "stale" | null {
  if (typeof value !== "string" || value === "") return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      s?: unknown;
      o?: unknown;
    };
    if (parsed.s !== scanId) return "stale";
    return typeof parsed.o === "number" && parsed.o >= 0 ? Math.floor(parsed.o) : "stale";
  } catch {
    return "stale";
  }
}

type ToolInput = Record<string, never> & Record<string, unknown>;

/** Long enough for an honest aggregate over a large scan, short enough to notice. */
const RAW_QUERY_TIMEOUT_MS = 5_000;

/**
 * Run one tool.
 *
 * Errors are returned as a result rather than thrown: the model can often
 * recover by calling a different tool, and an exception here would end the
 * turn with nothing to show the user.
 */
export async function runTool(
  ctx: ToolContext,
  name: string,
  input: ToolInput,
): Promise<ToolResult> {
  const finder = PAGED[name];
  if (finder) return runPaged(ctx, finder, input);

  switch (name) {
    case "summarise_account":
      return wrap([await q.summariseAccount(ctx.graph)]);

    case "get_resource": {
      const row = await q.getResource(ctx.graph, String(input["arnOrName"] ?? ""));
      return wrap(row ? [row] : [], row ? {} : { note: "No resource matched that ARN or name." });
    }

    case "suggest_remediation": {
      const row = await q.getResource(ctx.graph, String(input["arnOrName"] ?? ""));
      if (!row) return wrap([], { note: "No resource matched that ARN or name." });
      const remediations = remediationsFor(remediationInputFromGraph(row));
      return wrap(remediations.length > 0 ? [{ arn: row.arn, remediations }] : [], {
        note:
          remediations.length === 0
            ? `${row.name} has no findings that this can suggest a fix for. Say so plainly rather than inventing advice.`
            : "Sightline cannot apply these. Present them as commands for the user to run, with the caution attached to each.",
      });
    }

    case "find_network_paths": {
      const {
        paths: rows,
        found,
        stopped,
      } = await q.networkPaths(ctx.graph, {
        target: String(input["target"] ?? ""),
        source: input["source"] ? String(input["source"]) : undefined,
        maxHops: input["maxHops"] ? Number(input["maxHops"]) : undefined,
      });
      const bound =
        stopped === "time"
          ? "The search hit its time limit"
          : stopped === "paths"
            ? `The search stopped after ${found} paths`
            : null;
      return wrap(rows, {
        note:
          rows.length === 0 && !stopped
            ? "No path found. Nothing can reach this resource through security group rules, which is a meaningful answer rather than a failure."
            : bound
              ? `${bound}, so these are the shortest of the paths it found, not all of them. Say the list is not exhaustive; a lower maxHops or a named source narrows it.`
              : rows.length < found
                ? `${found} paths in all; these are the ${rows.length} shortest.`
                : undefined,
      });
    }

    case "find_reachable_from": {
      const { rows, total } = await q.reachableFrom(ctx.graph, {
        source: String(input["source"] ?? ""),
        maxHops: input["maxHops"] ? Number(input["maxHops"]) : undefined,
      });
      const shown = Math.max(rows.length - 1, 0);
      return wrap(rows, {
        note:
          total > shown
            ? `It reaches ${total} resources in all; these are the ${shown} nearest. Quote the total, not the length of this list.`
            : undefined,
      });
    }

    case "list_scans":
      return wrap(await listScans(ctx.scope, Number(input["limit"] ?? 10)));

    case "diff_scans": {
      let from = input["fromScanId"] ? String(input["fromScanId"]) : null;
      let to = input["toScanId"] ? String(input["toScanId"]) : null;
      if (!from || !to) {
        const scans = await listScans(ctx.scope, 2);
        if (scans.length < 2) {
          return wrap([], {
            note: "Only one scan exists, so there is nothing to compare it against yet.",
          });
        }
        to = to ?? scans[0]!.id;
        from = from ?? scans[1]!.id;
      }
      return wrap([await diffScans(ctx.scope, asScanId(from), asScanId(to))]);
    }

    case RAW_QUERY_TOOL: {
      // The second of the two gates. The first is `availableTools`.
      if (isHosted()) {
        agentRawQueryRefused.inc({ reason: "hosted" });
        return {
          rows: [],
          arns: [],
          note: "Raw SQL is not available in this deployment. Use the curated tools.",
        };
      }
      const statement = String(input["sql"] ?? "")
        .trim()
        .replace(/;\s*$/, "");
      const guard = assertSafeInventorySql(statement);
      if (!guard.ok) {
        agentRawQueryRefused.inc({ reason: guard.cause });
        return { rows: [], arns: [], note: `Query rejected: ${guard.reason}` };
      }
      try {
        const rows = await readOnlyAsTenant(
          ctx.graph.tenantId,
          `WITH resources AS (
             SELECT arn, kind, name, region, account_id, tags, properties, derived
               FROM resource_snapshots WHERE tenant_id = $1 AND scan_id = $2),
           relationships AS (
             SELECT from_arn, to_arn, rel_type, properties
               FROM relationship_snapshots WHERE tenant_id = $1 AND scan_id = $2),
           policy_documents AS (
             SELECT hash, document FROM policy_documents WHERE tenant_id = $1)
           SELECT * FROM (${statement}) AS q LIMIT 200`,
          [ctx.graph.tenantId, ctx.graph.scanId],
          RAW_QUERY_TIMEOUT_MS,
        );
        return wrap(rows, { query: statement });
      } catch (err) {
        agentRawQueryRefused.inc({ reason: "execution" });
        const message = err instanceof Error ? err.message : String(err);
        return { rows: [], arns: [], note: `Query failed: ${message}` };
      }
    }

    default:
      return { rows: [], arns: [], note: `Unknown tool "${name}".` };
  }
}

async function runPaged(
  ctx: ToolContext,
  finder: q.FinderName,
  input: ToolInput,
): Promise<ToolResult> {
  const offset = decodeCursor(input["cursor"], ctx.graph.scanId);
  if (offset === "stale") {
    return wrap([], {
      note: "That cursor belongs to another scan or is not one this tool issued. Call again without it.",
    });
  }
  const limit = Number(input["limit"]);
  const str = (key: string) => (typeof input[key] === "string" ? input[key] : undefined);
  const { rows, ...page } = await q.pageOf(finder, ctx.graph, {
    kind: str("kind"),
    region: str("region"),
    nameContains: str("nameContains"),
    text: str("text"),
    limit: Number.isFinite(limit) ? Math.min(limit, AGENT_MAX_PAGE_ROWS) : AGENT_PAGE_ROWS,
    offset: offset ?? 0,
  });
  return wrap(rows, { page });
}
