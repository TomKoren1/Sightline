/**
 * The agent's tools.
 *
 * Each one wraps a curated query (ADR-005). The model chooses which to call
 * and with what arguments; it never writes the Cypher, and none of these can
 * express a mutation - the read-only rule is enforced by construction
 * rather than by instruction.
 *
 * Descriptions matter more than they look. They are the only thing the model
 * sees when deciding what to call, so each says what the tool answers *and*
 * when to prefer it over a neighbour - most bad answers are a tool-choice
 * mistake, not a reasoning one.
 */

import type { JSONSchema7 } from "ai";

import * as q from "../db/queries.js";
import { remediationInputFromGraph } from "../remediation/fromGraph.js";
import { remediationsFor } from "../remediation/remediation.js";
import { readQuery } from "../db/neo4j.js";
import { diffScans, getLatestScan, listScans } from "../db/repository.js";
import { assertReadOnlyCypher } from "./cypherGuard.js";

export interface ToolResult {
  rows: unknown[];
  /** ARNs this result makes citable. */
  arns: string[];
  /** The Cypher actually run, surfaced in the UI for auditability. */
  query?: string;
  note?: string;
}

/** Pull ARNs out of arbitrary result rows, however deeply nested. */
function collectArns(value: unknown, into: Set<string>): void {
  if (typeof value === "string") {
    if (value.startsWith("arn:")) into.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectArns(item, into);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectArns(item, into);
  }
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
 * list is the tool boundary (ADR-005) and should not be shaped by whichever
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
        limit: { type: "number", description: "Max rows (default 100)." },
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
        limit: { type: "number" },
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
    input_schema: { type: "object", properties: { limit: { type: "number" } } },
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
    input_schema: { type: "object", properties: { limit: { type: "number" } } },
  },
  {
    name: "find_idle_resources",
    description:
      "Provisioned, billable resources showing no sign of use - unattached volumes, " +
      "unassociated elastic IPs, stopped instances, NAT gateways serving nothing - with " +
      "rough monthly cost, most expensive first. Use for 'what is costing money but not " +
      "being used?'. Costs are list-price estimates; present them as approximate.",
    input_schema: { type: "object", properties: { limit: { type: "number" } } },
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
    input_schema: { type: "object", properties: { limit: { type: "number" } } },
  },
  {
    name: "find_open_security_groups",
    description:
      "Resources directly exposed to 0.0.0.0/0, with the ports and the security group " +
      "responsible. Use for 'what is open to the internet?' and for spotting SSH or RDP " +
      "exposed to the world.",
    input_schema: { type: "object", properties: { limit: { type: "number" } } },
  },
  {
    name: "search_resources",
    description:
      "Free-text search across resource names, ARNs and tags. Use when the user names " +
      "something you cannot match exactly, before giving up on finding it.",
    input_schema: {
      type: "object",
      properties: { text: { type: "string" }, limit: { type: "number" } },
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
    name: "graph_query",
    description:
      "Run a read-only Cypher query against the resource graph. This is an escape hatch for " +
      "questions the tools above cannot express - try them first, as they are tested and " +
      "return reasoning. Nodes carry the label :Resource plus their kind (:Ec2Instance, " +
      ":S3Bucket, :IamRole, ...) and properties arn, name, kind, region, plus isPublic, " +
      "isAdmin, isIdle where computed. Relationships: IN_REGION, IN_VPC, IN_SUBNET, " +
      "HAS_SECURITY_GROUP, ATTACHED_TO, ROUTES_TO, USES_SUBNET_GROUP, HAS_INSTANCE_PROFILE, " +
      "PROVIDES_ROLE, HAS_POLICY, EXECUTES_AS, CAN_REACH. Write clauses are rejected.",
    input_schema: {
      type: "object",
      properties: {
        cypher: { type: "string", description: "A single read-only Cypher statement." },
      },
      required: ["cypher"],
    },
  },
];

type ToolInput = Record<string, never> & Record<string, unknown>;

/**
 * Run one tool.
 *
 * Errors are returned as a result rather than thrown: the model can often
 * recover by calling a different tool, and an exception here would end the
 * turn with nothing to show the user.
 */
export async function runTool(name: string, input: ToolInput): Promise<ToolResult> {
  switch (name) {
    case "summarise_account":
      return wrap([await q.summariseAccount()]);

    case "list_resources":
      return wrap(await q.listResources(input));

    case "get_resource": {
      const row = await q.getResource(String(input["arnOrName"] ?? ""));
      return wrap(row ? [row] : [], row ? {} : { note: "No resource matched that ARN or name." });
    }

    case "suggest_remediation": {
      const row = await q.getResource(String(input["arnOrName"] ?? ""));
      if (!row) return wrap([], { note: "No resource matched that ARN or name." });
      const remediations = remediationsFor(remediationInputFromGraph(row as never));
      return wrap(remediations.length > 0 ? [{ arn: row.arn, remediations }] : [], {
        note:
          remediations.length === 0
            ? `${row.name} has no findings that this can suggest a fix for. Say so plainly rather than inventing advice.`
            : "Sightline cannot apply these. Present them as commands for the user to run, with the caution attached to each.",
      });
    }

    case "find_public_resources":
      return wrap(await q.findPublicResources(input));

    case "find_admin_principals":
      return wrap(await q.findAdminPrincipals(input));

    case "find_network_paths": {
      const rows = await q.findNetworkPaths({
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
        await q.findReachableFrom({
          source: String(input["source"] ?? ""),
          maxHops: input["maxHops"] ? Number(input["maxHops"]) : undefined,
        }),
      );

    case "find_instances_in_public_subnets":
      return wrap(await q.findInstancesInPublicSubnets(input));

    case "find_idle_resources":
      return wrap(await q.findIdleResources(input));

    case "find_unprotected_buckets":
      return wrap(await q.findUnprotectedBuckets(input));

    case "find_open_security_groups":
      return wrap(await q.findOpenSecurityGroups(input));

    case "search_resources":
      return wrap(await q.searchResources({ text: String(input["text"] ?? "") }));

    case "list_scans":
      return wrap(await listScans(Number(input["limit"] ?? 10)));

    case "diff_scans": {
      let from = input["fromScanId"] ? String(input["fromScanId"]) : null;
      let to = input["toScanId"] ? String(input["toScanId"]) : null;
      if (!from || !to) {
        const scans = await listScans(2);
        if (scans.length < 2) {
          return wrap([], {
            note: "Only one scan exists, so there is nothing to compare it against yet.",
          });
        }
        to = to ?? scans[0]!.id;
        from = from ?? scans[1]!.id;
      }
      return wrap([await diffScans(from, to)]);
    }

    case "graph_query": {
      const cypher = String(input["cypher"] ?? "");
      const guard = assertReadOnlyCypher(cypher);
      if (!guard.ok) {
        return { rows: [], arns: [], note: `Query rejected: ${guard.reason}` };
      }
      const rows = await readQuery(cypher);
      return wrap(rows.slice(0, 200), { query: cypher });
    }

    default:
      return { rows: [], arns: [], note: `Unknown tool "${name}".` };
  }
}

export { getLatestScan };
