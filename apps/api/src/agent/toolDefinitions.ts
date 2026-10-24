/**
 * What the agent is offered: each tool's name, the description the model
 * chooses by, and the JSON Schema of its arguments. The descriptions are the
 * only thing the model sees when deciding what to call, so each says what the
 * tool answers and when to prefer it over a neighbour.
 */

import type { JSONSchema7 } from "ai";

import { RELATIONSHIP_TYPES } from "@sightline/shared";
import { isHosted } from "../core/config.js";

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

export const AGENT_PAGE_ROWS = 50;
export const AGENT_MAX_PAGE_ROWS = 200;

const PAGE_PROPERTIES = {
  limit: {
    type: "number",
    description: `Rows per page (default ${AGENT_PAGE_ROWS}, at most ${AGENT_MAX_PAGE_ROWS}).`,
  },
  cursor: { type: "string", description: "The cursor a previous page returned, to continue it." },
} satisfies Record<string, JSONSchema7>;

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
    name: "find_unused_access",
    description:
      "IAM roles nobody has assumed, and users whose console password or active access keys " +
      "nobody has used, in 90 days or more - administrators first. From IAM's own last-used " +
      "tracking; anything newer than 90 days is never listed. Use for 'what access can we " +
      "remove?', 'which roles are unused?', 'are there stale access keys?'. A user whose " +
      "activity could not be read is absent, not cleared: say so if the list looks short.",
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
