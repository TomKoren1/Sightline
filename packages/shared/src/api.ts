/**
 * The HTTP API's responses, defined once. Each shape used to be written three
 * times - by the handler, by a schema in the API's contract test, and as an
 * interface in the web client - and only the first two were compared. Now
 * this schema is the contract: the contract test validates real responses
 * against it, the web infers its types from it, and the server types its
 * returns with it where its own types are exact. A separate entry,
 * `@sightline/shared/api`, not re-exported from the index: the browser imports
 * these as types only, and schemas built at load would join its bundle.
 */

import { z } from "zod";

// --- the graph ---------------------------------------------------------------

/** A resource as every list renders it, with whichever verdicts the query read. */
export const graphNode = z.object({
  arn: z.string(),
  kind: z.string(),
  name: z.string(),
  region: z.string().nullable(),
  isPublic: z.boolean().nullable().optional(),
  isAdmin: z.boolean().nullable().optional(),
  isIdle: z.boolean().nullable().optional(),
  isUnprotected: z.boolean().nullable().optional(),
  isUnused: z.boolean().nullable().optional(),
  estimatedMonthlyCostUsd: z.number().nullable().optional(),
  reason: z.string().nullable().optional(),
});
export type GraphNode = z.infer<typeof graphNode>;

export const graphEdge = z.object({
  from: z.string(),
  to: z.string(),
  type: z.string(),
  ports: z.string().nullable().optional(),
});
export type GraphEdge = z.infer<typeof graphEdge>;

export const graphData = z
  .object({
    nodes: z.array(graphNode),
    edges: z.array(graphEdge),
    /** Every node that matched; `nodes` is capped. */
    total: z.number(),
    truncated: z.boolean(),
  })
  .strict();
export type GraphData = z.infer<typeof graphData>;

/** A VPC, or a kind of resource that lives outside one, with what is in it. */
export const graphGroup = z
  .object({
    id: z.string().regex(/^(vpc|kind):/),
    name: z.string(),
    region: z.string().nullable(),
    count: z.number(),
    publicCount: z.number(),
    adminCount: z.number(),
    kinds: z.record(z.string(), z.number()),
  })
  .strict();
export type GraphGroup = z.infer<typeof graphGroup>;
export const graphGroups = z.object({ groups: z.array(graphGroup) }).strict();

export const summary = z
  .object({
    byKind: z.array(z.object({ kind: z.string(), count: z.number() }).strict()),
    byRegion: z.array(z.object({ region: z.string(), count: z.number() }).strict()),
    publicCount: z.number(),
    adminCount: z.number(),
    idleCount: z.number(),
    idleCost: z.number(),
    unprotectedCount: z.number(),
    unusedCount: z.number(),
  })
  .strict();
export type Summary = z.infer<typeof summary>;

export const searchResults = z.object({ results: z.array(graphNode) }).strict();

// --- findings ----------------------------------------------------------------

export const findingCategory = z.enum(["exposed", "admin", "idle", "unguarded", "unused"]);
export type FindingCategory = z.infer<typeof findingCategory>;

/** A finding's tracked state. Null on a finding no scan has recorded yet. */
export const findingState = z.object({
  id: z.string(),
  status: z.enum(["open", "accepted"]),
  firstSeenAt: z.string(),
  statusReason: z.string().nullable().optional(),
  statusAt: z.string().nullable().optional(),
});
export type FindingState = z.infer<typeof findingState>;

const tracked = <T extends z.ZodRawShape>(extra: T) =>
  graphNode.extend({ reason: z.string(), finding: findingState.nullable(), ...extra });

export const findings = z
  .object({
    publicResources: z.array(tracked({})),
    adminPrincipals: z.array(
      tracked({
        adminVia: z.string().nullable().optional(),
        usedBy: z.array(z.object({ arn: z.string(), name: z.string(), kind: z.string() })),
        useCount: z.number(),
      }),
    ),
    idle: z.array(tracked({ estimatedMonthlyCostUsd: z.number().nullable() })),
    exposed: z.array(
      tracked({
        ports: z.array(z.string().nullable()).optional(),
        securityGroup: z.string().nullable().optional(),
      }),
    ),
    /** Not public, but nothing would stop them becoming public. */
    unprotected: z.array(tracked({ isPublic: z.boolean() })),
    /** Roles and users nobody has used in 90 days. */
    unused: z.array(tracked({ isAdmin: z.boolean(), lastUsedAt: z.string().nullable() })),
    /** Findings somebody accepted the risk of, still present in the current scan. */
    accepted: z.array(
      graphNode.extend({
        category: findingCategory,
        reason: z.string().nullable(),
        finding: findingState.extend({ status: z.literal("accepted") }),
      }),
    ),
  })
  .strict();
export type Findings = z.infer<typeof findings>;

export const acrossAccounts = z
  .object({
    accounts: z.array(
      z
        .object({
          connectionId: z.string(),
          label: z.string(),
          accountId: z.string().nullable(),
          open: z.record(findingCategory, z.number()),
        })
        .strict(),
    ),
    findings: z.array(
      z
        .object({
          id: z.string(),
          connectionId: z.string(),
          category: findingCategory,
          arn: z.string(),
          name: z.string(),
          kind: z.string(),
          reason: z.string().nullable(),
          firstSeenAt: z.string(),
        })
        .strict(),
    ),
  })
  .strict();
export type AcrossAccounts = z.infer<typeof acrossAccounts>;

// --- accounts, the team, and access -------------------------------------------

export const teamRole = z.enum(["owner", "admin", "member", "viewer"]);
export type TeamRole = z.infer<typeof teamRole>;

export const connectionSummary = z
  .object({
    id: z.string(),
    kind: z.enum(["real", "demo", "organization"]),
    label: z.string(),
    accountId: z.string().nullable(),
    roleArn: z.string().nullable(),
    status: z.enum(["pending", "verified", "failed", "disconnected"]),
    lastError: z.string().nullable(),
    scanRegions: z.array(z.string()),
    templateVersion: z.string().nullable(),
    lastVerifiedAt: z.string().nullable(),
    lastScanAt: z.string().nullable(),
    /** The organization connection that found this account, if one did. */
    parentId: z.string().nullable(),
  })
  // No external id, encrypted or otherwise. Strict, so adding one to the
  // summary fails the contract test rather than reaching a browser.
  .strict();
export type ConnectionSummary = z.infer<typeof connectionSummary>;
export const connectionList = z.object({ connections: z.array(connectionSummary) }).strict();

/** What `/api/me` answers: everything the UI's first frame needs. */
export const me = z
  .object({
    hosted: z.boolean(),
    signedIn: z.boolean(),
    user: z
      .object({ email: z.string(), name: z.string().nullable(), avatarUrl: z.string().nullable() })
      .strict()
      .nullable(),
    isAdmin: z.boolean(),
    /** Their role in this workspace; null when signed out. Always owner self-hosted. */
    role: teamRole.nullable(),
    providers: z.array(z.string()),
    linked: z.array(z.string()),
    connections: z.array(connectionSummary),
  })
  .strict();
export type Me = z.infer<typeof me>;

export const team = z
  .object({
    you: z.object({ id: z.string(), role: teamRole }).strict(),
    members: z.array(
      z
        .object({
          id: z.string(),
          email: z.string(),
          name: z.string().nullable(),
          role: teamRole,
          joinedAt: z.string(),
          lastSeenAt: z.string().nullable(),
        })
        .strict(),
    ),
    invites: z.array(
      z
        .object({
          id: z.string(),
          role: teamRole,
          createdAt: z.string(),
          expiresAt: z.string(),
          createdBy: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type Team = z.infer<typeof team>;

export const sessionRow = z
  .object({
    id: z.string(),
    createdAt: z.string(),
    lastUsedAt: z.string().nullable(),
    userAgent: z.string().nullable(),
    current: z.boolean(),
  })
  .strict();
export type SessionRow = z.infer<typeof sessionRow>;

export const apiToken = z
  .object({
    id: z.string(),
    name: z.string(),
    role: teamRole,
    createdAt: z.string(),
    lastUsedAt: z.string().nullable(),
    expiresAt: z.string().nullable(),
    createdBy: z.string(),
  })
  .strict();
export type ApiToken = z.infer<typeof apiToken>;

export const auditEntry = z
  .object({
    id: z.string(),
    at: z.string(),
    action: z.string(),
    subject: z.string().nullable(),
    detail: z.record(z.string(), z.unknown()),
    ip: z.string().nullable(),
    actor: z.object({ id: z.string(), email: z.string().nullable() }).strict().nullable(),
  })
  .strict();
export type AuditEntry = z.infer<typeof auditEntry>;
export const auditPage = z
  .object({ entries: z.array(auditEntry), next: z.string().nullable() })
  .strict();
export const auditExport = z.object({ entries: z.array(auditEntry) }).strict();

export const tenantHealth = z
  .object({
    id: z.string(),
    name: z.string(),
    createdAt: z.string(),
    members: z.number(),
    connections: z.number(),
    activeScans: z.number(),
    scansFailed7d: z.number(),
    scansSucceeded7d: z.number(),
    lastScan: z
      .object({ status: z.string(), at: z.string().nullable(), error: z.string().nullable() })
      .strict()
      .nullable(),
    questions24h: z.number(),
    tokens24h: z.number(),
  })
  .strict();
export type TenantHealth = z.infer<typeof tenantHealth>;
export const tenantHealthList = z.object({ tenants: z.array(tenantHealth) }).strict();

/** The workspace's webhook, as far as anyone may see it: its host, never its URL. */
export const webhookView = z
  .object({
    configured: z.boolean(),
    host: z.string().nullable(),
    lastDeliveryAt: z.string().nullable(),
    lastStatus: z.string().nullable(),
  })
  .strict();
export type WebhookView = z.infer<typeof webhookView>;
