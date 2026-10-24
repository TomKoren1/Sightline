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

import type { JSONSchema7 } from "ai";

import { RELATIONSHIP_TYPES } from "@sightline/shared";
import * as q from "../db/graph.js";
import { isHosted } from "../config.js";
import { remediationInputFromGraph } from "../remediation/fromGraph.js";
import { remediationsFor } from "../remediation/remediation.js";
import type { GraphScope } from "../db/graph.js";
import { readOnlyAsTenant } from "../db/postgres.js";
import { diffScans, getLatestScan, listScans } from "../db/repository.js";
import { asScanId } from "../tenancy/ids.js";
import type { Scope } from "../tenancy/scope.js";
import { agentRawQueryRefused } from "../observability/metrics.js";
import { assertSafeInventorySql } from "./sqlGuard.js";

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

/** The SQL escape hatch, by name, because two places refer to it. */
export const RAW_QUERY_TOOL = "inventory_sql";

/**
 * The tools on offer.
 *
 * In hosted mode the SQL escape hatch is **not offered**, and the dispatch
 * refuses it independently - the list is a suggestion and the dispatch is the
 * gate, because a model can call a tool it was never offered. Its reads are
 * tenant-isolated by row-level security and pinned to one scan, so this is
 * defence in depth rather than the only lock.
 */
export function availableTools(): ToolDefinition[] {
  return isHosted() ? TOOL_DEFINITIONS.filter((t) => t.name !== RAW_QUERY_TOOL) : TOOL_DEFINITIONS;
}

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
  find_open_security_groups: "findOpenSecurityGroups",
  find_cross_account_access: "findCrossAccountAccess",
  search_resources: "searchResources",
};

export const AGENT_PAGE_ROWS = 50;
const AGENT_MAX_PAGE_ROWS = 200;

const PAGE_PROPERTIES = {
  limit: {
    type: "number",
    description: `Rows per page (default ${AGENT_PAGE_ROWS}, at most ${AGENT_MAX_PAGE_ROWS}).`,
  },
  cursor: { type: "string", description: "The cursor a previous page returned, to continue it." },
} satisfies Record<string, JSONSchema7>;

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

const wrap = (rows: unknown[], extra: Partial<ToolResult> = {}): ToolResult => {
  const arns = new Set<string>();
  collectArns(rows, arns);
  return { rows, arns: [...arns], ...extra };
};

/**
 * A tool as the model sees it: a name, the description it chooses on, and a
 * JSON Schema for the arguments.
 *
 * Declared here rather than borrowed from a provider's SDK types, because this
 * list is the tool boundary and should not be shaped by whichever
 * client happens to deliver it. `agent.ts` hands these to the AI SDK verbatim.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: JSONSchema7;
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "summarise_account",
    description:
      "Counts of resources by type and region, plus how many are public, admin or idle. " +
      "Call this first for broad questions like 'what's in this account?' or when you need " +
      "orientation before choosing a more specific tool. Cheap.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "list_resources",
    description:
      "List resources, optionally filtered by type, region, or a substring of the name. " +
      "Use for 'show me all X' questions. For security questions prefer the dedicated tools " +
      "below, which return the reasoning behind each verdict.",
    input_schema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          description:
            "Resource type, e.g. Ec2Instance, S3Bucket, IamRole, RdsInstance, LambdaFunction, " +
            "SecurityGroup, Vpc, Subnet, EbsVolume, NatGateway, ElasticIp.",
        },
        region: { type: "string", description: "AWS region, e.g. us-east-1." },
        nameContains: { type: "string", description: "Case-insensitive substring of the name." },
        ...PAGE_PROPERTIES,
      },
    },
  },
  {
    name: "get_resource",
    description:
      "Everything known about one resource, including its immediate neighbours in the graph. " +
      "Accepts an ARN or an exact name. Use when the user asks about a specific resource, or " +
      "when you need a detail another tool did not return.",
    input_schema: {
      type: "object",
      properties: { arnOrName: { type: "string", description: "ARN or exact resource name." } },
      required: ["arnOrName"],
    },
  },
  {
    name: "find_public_resources",
    description:
      "Resources reachable by an anonymous caller from the public internet, each with the " +
      "evidence behind the verdict. Use for 'which buckets are public?', 'what is exposed?'. " +
      "The verdict already accounts for public access blocks overriding a permissive policy, " +
      "so trust it over your own reading of a policy document.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", description: "Restrict to one type, e.g. S3Bucket." },
        ...PAGE_PROPERTIES,
      },
    },
  },
  {
    name: "find_admin_principals",
    description:
      "IAM roles AND IAM users with effective administrator access (Action '*' on Resource " +
      "'*'), whether granted by a managed or an inline policy, together with what uses each " +
      "role. Use for 'who has admin access?'. Check the `kind` field: a role attached to a " +
      "running instance is an incident, a role nothing uses is cleanup, and a *user* with " +
      "admin has long-lived credentials and no usage data here - report it as its own risk " +
      "rather than as an unused role.",
    input_schema: { type: "object", properties: { ...PAGE_PROPERTIES } },
  },
  {
    name: "find_network_paths",
    description:
      "Every network path by which a target can be reached, following security group rules " +
      "hop by hop. Defaults to starting from the public internet. Use for 'what can reach X?' " +
      "and 'is X exposed?'. An empty result is a meaningful answer: nothing can reach it. " +
      "Prefer this over reasoning about security groups yourself.",
    input_schema: {
      type: "object",
      properties: {
        target: { type: "string", description: "ARN or exact name of the resource being reached." },
        source: {
          type: "string",
          description: "ARN or name to start from. Omit to start from the public internet.",
        },
        maxHops: { type: "number", description: "Max path length, 1-8 (default 5)." },
      },
      required: ["target"],
    },
  },
  {
    name: "find_reachable_from",
    description:
      "What a given resource can reach - the inverse of find_network_paths. Use for blast-radius " +
      "questions: 'if this host were compromised, what could it talk to?'. The source resource " +
      "is included in the results at hops 0, so its ARN is available to cite; everything else " +
      "is a target with the number of hops to it. An empty result means no such resource, " +
      "whereas a single row means the resource exists and reaches nothing.",
    input_schema: {
      type: "object",
      properties: {
        source: { type: "string", description: "ARN or exact name." },
        maxHops: { type: "number" },
      },
      required: ["source"],
    },
  },
  {
    name: "find_instances_in_public_subnets",
    description:
      "EC2 instances that are not in a private subnet - either in a subnet that routes " +
      "0.0.0.0/0 to an internet gateway, or in no subnet at all. Use for 'which instances " +
      "aren't in a private subnet?'.",
    input_schema: { type: "object", properties: { ...PAGE_PROPERTIES } },
  },
  {
    name: "find_idle_resources",
    description:
      "Provisioned, billable resources showing no sign of use - unattached volumes, " +
      "unassociated elastic IPs, stopped instances, NAT gateways serving nothing - with " +
      "rough monthly cost, most expensive first. Use for 'what is costing money but not " +
      "being used?'. Costs are list-price estimates; present them as approximate.",
    input_schema: { type: "object", properties: { ...PAGE_PROPERTIES } },
  },
  {
    name: "find_unprotected_buckets",
    description:
      "S3 buckets whose Block Public Access settings are off or incomplete. These buckets are " +
      "NOT public - nothing grants anonymous access - but nothing would stop a future policy or " +
      "ACL from making them public. Use for 'which buckets could be made public?', 'is Block " +
      "Public Access enabled?', and when a user expects a bucket to be public because they " +
      "disabled the block. Never describe these as public: that is a different question, " +
      "answered by find_public_resources.",
    input_schema: { type: "object", properties: { ...PAGE_PROPERTIES } },
  },
  {
    name: "find_open_security_groups",
    description:
      "Resources directly exposed to 0.0.0.0/0, with the ports and the security group " +
      "responsible. Use for 'what is open to the internet?' and for spotting SSH or RDP " +
      "exposed to the world.",
    input_schema: { type: "object", properties: { ...PAGE_PROPERTIES } },
  },
  {
    name: "find_cross_account_access",
    description:
      "What other AWS accounts can reach in this one: roles whose trust policy lets another " +
      "account assume them, and resources whose policy grants another account. Each row names " +
      "the account, whether it is one of this customer's own connected accounts (known) or a " +
      "stranger, whether an ExternalId or organization condition narrows it, and whether the " +
      "role is an administrator. Use for 'who outside can get in?', 'which roles do vendors " +
      "assume?', 'is anything shared with an account we do not recognise?'.",
    input_schema: { type: "object", properties: { ...PAGE_PROPERTIES } },
  },
  {
    name: "search_resources",
    description:
      "Free-text search across resource names, ARNs and tags. Use when the user names " +
      "something you cannot match exactly, before giving up on finding it.",
    input_schema: {
      type: "object",
      properties: { text: { type: "string" }, ...PAGE_PROPERTIES },
      required: ["text"],
    },
  },
  {
    name: "list_scans",
    description:
      "Recent scans with their status, timing and per-service outcomes. Use to answer 'when " +
      "was this last scanned?', 'did anything fail?', or to find scan ids for diff_scans.",
    input_schema: { type: "object", properties: { limit: { type: "number" } } },
  },
  {
    name: "diff_scans",
    description:
      "What changed between two scans: resources added, removed, and modified with the " +
      "specific fields that differ. Use for 'what changed since the last scan?'. With no " +
      "arguments it compares the two most recent scans.",
    input_schema: {
      type: "object",
      properties: {
        fromScanId: { type: "string", description: "Older scan id. Omit for second-most-recent." },
        toScanId: { type: "string", description: "Newer scan id. Omit for most recent." },
      },
    },
  },
  {
    name: "suggest_remediation",
    description:
      "For one resource, the exact commands that would fix what is wrong with it, what each " +
      "change might break, and a read-only command to confirm it worked. Use when asked 'how do " +
      "I fix this?', 'what should I do about X?' or after reporting a finding the user is likely " +
      "to act on. Returns nothing when the resource has no findings, which is a real answer. " +
      "These are computed from the same evidence as the verdict, not written by you - quote them " +
      "verbatim rather than composing your own commands, and always pass on the `caution`, " +
      "because a command without its blast radius is the dangerous half of the advice. " +
      "Sightline cannot run any of them; say so if the user seems to expect otherwise.",
    input_schema: {
      type: "object",
      properties: { arnOrName: { type: "string" } },
      required: ["arnOrName"],
    },
  },
  {
    name: "inventory_sql",
    description:
      "Run one read-only PostgreSQL SELECT over this scan. An escape hatch for questions the " +
      "tools above cannot express - try them first, as they are tested and return reasoning. " +
      "Three views: resources(arn, kind, name, region, account_id, tags jsonb, properties jsonb, " +
      "derived jsonb), relationships(from_arn, to_arn, rel_type, properties jsonb) and " +
      "policy_documents(hash, document jsonb). IAM policy documents are stored once: where a " +
      "property would hold a `document`, it holds a `documentRef` hash to join on. `derived` " +
      "holds the computed verdicts: isPublic, isAdmin, adminVia, isIdle, isUnprotected and a " +
      "*Reason for each, plus estimatedMonthlyCostUsd - read booleans as (derived->>'isAdmin')::boolean. " +
      `rel_type is one of ${RELATIONSHIP_TYPES.join(", ")}. A CAN_REACH row whose from_arn is a ` +
      "SecurityGroup or a Subnet means every member of it (via HAS_SECURITY_GROUP or IN_SUBNET) " +
      "can reach to_arn; prefer find_network_paths for paths. " +
      "Only these views and common functions are allowed; at most 200 rows come back.",
    input_schema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "A single SELECT statement." },
      },
      required: ["sql"],
    },
  },
];

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
      const rows = await q.findNetworkPaths(ctx.graph, {
        target: String(input["target"] ?? ""),
        source: input["source"] ? String(input["source"]) : undefined,
        maxHops: input["maxHops"] ? Number(input["maxHops"]) : undefined,
      });
      return wrap(rows, {
        note:
          rows.length === 0
            ? "No path found. Nothing can reach this resource through security group rules, which is a meaningful answer rather than a failure."
            : undefined,
      });
    }

    case "find_reachable_from":
      return wrap(
        await q.findReachableFrom(ctx.graph, {
          source: String(input["source"] ?? ""),
          maxHops: input["maxHops"] ? Number(input["maxHops"]) : undefined,
        }),
      );

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

export { getLatestScan };
