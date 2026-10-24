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
export type SearchResults = z.infer<typeof searchResults>;

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

// --- health, the self-hosted connection, onboarding and evals -----------------

const lastScanRef = z.object({ id: z.string(), at: z.string(), status: z.string() }).strict();

export const health = z
  .object({
    status: z.string(),
    checks: z.object({ postgres: z.string(), agent: z.string() }).strict(),
    awsMode: z.string(),
    lastScan: lastScanRef.nullable(),
  })
  .strict();
export type Health = z.infer<typeof health>;

/** The self-hosted deployment's one connection, as the onboarding guide reads it. */
export const connection = z
  .object({
    /** The raw session ARN GetCallerIdentity reports. Shown, but not pasteable. */
    callerIdentity: z.string().nullable(),
    /** True when that identity came from the mock rather than from AWS. */
    callerIdentityIsMock: z.boolean(),
    /** The identity as a principal a trust policy can name, or null with the reason below. */
    scannerPrincipal: z.string().nullable(),
    scannerPrincipalConverted: z.boolean(),
    scannerPrincipalNote: z.string().nullable(),
    /** Set when AWS_TARGET_ROLE_ARN cannot be assumed at all. */
    roleArnProblem: z.string().nullable(),
    /** True when the API runs in a container, so the guide shows the right restart. */
    containerised: z.boolean(),
    mode: z.enum(["mock", "real"]),
    /** What .env says, so the UI can show when the toggle has diverged. */
    configuredMode: z.enum(["mock", "real"]),
    realAccountConfigured: z.boolean(),
    roleArn: z.string(),
    accountId: z.string().nullable(),
    externalIdMasked: z.string(),
    externalIdIsPlaceholder: z.boolean(),
    homeRegion: z.string(),
    /** Null when every enabled region is scanned. */
    regions: z.array(z.string()).nullable(),
    endpointOverride: z.string().nullable(),
    lastScan: lastScanRef.nullable(),
  })
  .strict();
export type Connection = z.infer<typeof connection>;

export const connectionTest = z
  .object({
    ok: z.boolean(),
    durationMs: z.number(),
    mode: z.string(),
    assumedRoleArn: z.string().optional(),
    accountId: z.string().optional(),
    callerArn: z.string().nullable().optional(),
    callerIdentity: z.string().nullable().optional(),
    expiresAt: z.string().optional(),
    endpoint: z.string().optional(),
    code: z.string().optional(),
    problem: z.string().optional(),
    fix: z.string().optional(),
  })
  .strict();
export type ConnectionTest = z.infer<typeof connectionTest>;

/** What connecting an account asks the customer to deploy. */
export const onboardingPlan = z
  .object({
    connection: connectionSummary,
    externalId: z.string(),
    scannerPrincipalArn: z.string(),
    templateUrl: z.string(),
    templateVersion: z.string(),
    launchUrl: z.string(),
    cliCommand: z.string(),
    terraform: z.string(),
    roleArnPattern: z.string(),
    /** For an organization: the StackSet that puts the role in every member. */
    stackSet: z.string().optional(),
  })
  .strict();
export type OnboardingPlan = z.infer<typeof onboardingPlan>;

export const verifyResult = z
  .object({
    ok: z.boolean(),
    accountId: z.string().optional(),
    assumedRoleArn: z.string().optional(),
    durationMs: z.number(),
    /** The useful part of a failure: what is wrong and what to do about it. */
    diagnosis: z.object({ code: z.string(), problem: z.string(), fix: z.string() }).optional(),
    /** A refusal that is not a diagnosis - the account reached is not the one agreed. */
    problem: z.string().optional(),
    /** For an organization: the accounts it found, and how each one's check went. */
    organization: z
      .object({
        found: z.number(),
        added: z.number(),
        departed: z.number(),
        alreadyConnected: z.array(z.string()),
        members: z.array(
          z.object({
            connectionId: z.string(),
            label: z.string(),
            ok: z.boolean(),
            problem: z.string().optional(),
          }),
        ),
        unchecked: z.number(),
      })
      .optional(),
  })
  .strict();
export type VerifyResult = z.infer<typeof verifyResult>;

export const checkResult = z.object({
  id: z.string(),
  description: z.string(),
  rationale: z.string(),
  passed: z.boolean(),
  detail: z.string(),
  /** Why drift accounts for this failure; set only on a failing check in a drifted account. */
  expectedAfterDrift: z.string().nullable().optional(),
});
export type CheckResult = z.infer<typeof checkResult>;

export const groundTruthRun = z.object({
  scanId: z.string(),
  scannedAt: z.string(),
  durationMs: z.number(),
  total: z.number(),
  passed: z.number(),
  /** True when the account has been changed since seeding, so failures are expected. */
  drifted: z.boolean(),
  driftNote: z.string().optional(),
  /** Failing checks that drift does not account for. Non-zero means investigate. */
  unexplainedFailures: z.number(),
  results: z.array(checkResult),
});
export type GroundTruthRun = z.infer<typeof groundTruthRun>;

export const checkList = z
  .object({
    checks: z.array(
      z.object({ id: z.string(), description: z.string(), rationale: z.string() }).strict(),
    ),
  })
  .strict();

export const agentEvalCase = z.object({
  id: z.string(),
  question: z.string(),
  passed: z.boolean(),
  f1: z.number(),
  toolsCalled: z.array(z.string()),
  failures: z.array(z.string()),
  unsupportedCitations: z.number(),
  durationMs: z.number(),
  /** Non-null when the request never reached the model, rather than the answer being wrong. */
  errored: z.string().nullable(),
});
export type AgentEvalCase = z.infer<typeof agentEvalCase>;

export const agentEvalRun = z.object({
  id: z.string(),
  startedAt: z.string(),
  model: z.string(),
  total: z.number(),
  passed: z.number(),
  /** Cases that actually ran; passed and meanF1 are out of this, not total. */
  graded: z.number(),
  errored: z.number(),
  meanF1: z.number(),
  unsupportedCitations: z.number(),
  /** Present when some cases never ran, so the run is not a quality measurement. */
  incompleteNote: z.string().optional(),
  cases: z.array(agentEvalCase),
});
export type AgentEvalRun = z.infer<typeof agentEvalRun>;

/** Two shapes, not one with an optional field: with no run there is a hint and no model. */
export const latestEvalRun = z.union([
  z.object({ run: z.null(), hint: z.string() }).strict(),
  z.object({ run: agentEvalRun.nullable(), currentModel: z.string() }).strict(),
]);

/** The next page of one findings list; `next` is null on the last. */
export const findingsPage = z
  .object({
    rows: z.array(graphNode.extend({ finding: findingState.nullable() }).passthrough()),
    total: z.number(),
    offset: z.number(),
    next: z.number().nullable(),
  })
  .strict();
export type FindingsPage = z.infer<typeof findingsPage>;
export const findingLists = [
  "publicResources",
  "adminPrincipals",
  "idle",
  "exposed",
  "unprotected",
  "unused",
] as const;
export type FindingListName = (typeof findingLists)[number];

// --- request bodies ------------------------------------------------------------
// What each route accepts, validated by the server before anything else runs.

export const askRequest = z.object({
  question: z.string().min(1).max(2000),
  /**
   * The only way to continue a conversation. History is never accepted from
   * the client: a client-supplied transcript lets a user put words in the
   * assistant's mouth, which the agent then treats as its own earlier answers.
   */
  conversationId: z.string().uuid().optional(),
});

/** Accepting a risk needs a reason: "accepted" alone tells the next engineer nothing. */
export const findingStatusRequest = z.discriminatedUnion("status", [
  z.object({ status: z.literal("accepted"), reason: z.string().trim().min(3).max(500) }),
  z.object({ status: z.literal("open") }),
]);

export const tokenCreateRequest = z.object({
  name: z.string().trim().min(1).max(80),
  role: z.enum(["viewer", "member", "admin"]),
  /** Null for a token that does not expire, which the UI does not offer by default. */
  expiresInDays: z.number().int().min(1).max(366).nullable().default(90),
});

export const connectionCreateRequest = z.object({
  kind: z.enum(["real", "demo", "organization"]).default("real"),
  label: z.string().trim().min(1).max(60),
});

export const connectionTargetRequest = z.object({
  /** Twelve digits. The role ARN is derived, so this is the only field. */
  accountId: z.string().regex(/^\d{12}$/, "An AWS account id is twelve digits"),
  templateVersion: z.string().max(40).optional(),
});

export const teamRoleRequest = z.object({ role: teamRole });
export const teamJoinRequest = z.object({ token: z.string().min(20).max(200) });
