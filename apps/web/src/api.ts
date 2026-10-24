/** API client. Thin on purpose - the interesting logic lives server-side. */

import type { AgentEvent, AgentMessage, ScanDiff, ScanEvent, ScanRun } from "@sightline/shared";

export interface GraphNode {
  arn: string;
  kind: string;
  name: string;
  region: string | null;
  isPublic?: boolean | null;
  isAdmin?: boolean | null;
  isIdle?: boolean | null;
  isUnprotected?: boolean | null;
  isUnused?: boolean | null;
  estimatedMonthlyCostUsd?: number | null;
  reason?: string | null;
}

export interface GraphEdge {
  from: string;
  to: string;
  type: string;
  ports?: string | null;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Every node that matched; `nodes` is capped. */
  total: number;
  truncated: boolean;
}

/** A VPC, or a kind of resource that lives outside one, with what is in it. */
export interface GraphGroup {
  id: string;
  name: string;
  region: string | null;
  count: number;
  publicCount: number;
  adminCount: number;
  kinds: Record<string, number>;
}

export interface Summary {
  byKind: { kind: string; count: number }[];
  byRegion: { region: string; count: number }[];
  publicCount: number;
  adminCount: number;
  idleCount: number;
  idleCost: number;
  unprotectedCount: number;
  unusedCount: number;
}

export type FindingCategory = "exposed" | "admin" | "idle" | "unguarded" | "unused";

/** A finding's tracked state. Null on a finding no scan has recorded yet. */
export interface FindingState {
  id: string;
  status: "open" | "accepted";
  firstSeenAt: string;
  statusReason?: string | null;
  statusAt?: string | null;
}

type Tracked<T> = T & { reason?: string | null; finding: FindingState | null };

export interface Findings {
  publicResources: Tracked<GraphNode>[];
  /** Not public, but nothing would stop them becoming public. */
  unprotected: Tracked<GraphNode & { isPublic?: boolean }>[];
  adminPrincipals: Tracked<GraphNode & { usedBy?: GraphNode[]; useCount?: number }>[];
  idle: Tracked<GraphNode>[];
  /** Roles and users nobody has used in 90 days. */
  unused: Tracked<GraphNode & { lastUsedAt?: string | null }>[];
  exposed: Tracked<GraphNode & { ports?: string[]; securityGroup?: string }>[];
  /** Findings somebody accepted the risk of, still present in the current scan. */
  accepted: (GraphNode & {
    category: FindingCategory;
    reason?: string | null;
    finding: FindingState;
  })[];
}

export interface CheckResult {
  id: string;
  description: string;
  rationale: string;
  passed: boolean;
  detail: string;
  /**
   * Why drift accounts for this failure, or null when it does not.
   *
   * Only ever set on a failing check in a drifted account. A failing check with
   * this null is a failure nothing explains, and must stay loud.
   */
  expectedAfterDrift?: string | null;
}

export interface GroundTruthRun {
  scanId: string;
  scannedAt: string;
  durationMs: number;
  total: number;
  passed: number;
  /** True when the account has been changed since seeding, so failures are expected. */
  drifted: boolean;
  driftNote?: string;
  /** Failing checks that drift does not account for. Non-zero means investigate. */
  unexplainedFailures: number;
  results: CheckResult[];
}

export interface AgentEvalCase {
  id: string;
  question: string;
  passed: boolean;
  f1: number;
  toolsCalled: string[];
  failures: string[];
  unsupportedCitations: number;
  durationMs: number;
  /** Non-null when the request never reached the model, rather than the answer being wrong. */
  errored: string | null;
}

export interface AgentEvalRun {
  id: string;
  startedAt: string;
  model: string;
  total: number;
  passed: number;
  /** Cases that actually ran. `passed` and `meanF1` are out of this, not `total`. */
  graded: number;
  errored: number;
  meanF1: number;
  unsupportedCitations: number;
  /** Present when some cases never ran, so the run is not a quality measurement. */
  incompleteNote?: string;
  cases: AgentEvalCase[];
}

export interface Connection {
  /** The raw session ARN GetCallerIdentity reports. Shown, but not pasteable. */
  callerIdentity: string | null;
  /** True when that identity came from the mock rather than from AWS. */
  callerIdentityIsMock: boolean;
  /**
   * The identity converted into a principal a trust policy can name, or null
   * with the reason in `scannerPrincipalNote`. This is the value to paste.
   */
  scannerPrincipal: string | null;
  scannerPrincipalConverted: boolean;
  scannerPrincipalNote: string | null;
  /** Set when AWS_TARGET_ROLE_ARN cannot be assumed at all. */
  roleArnProblem: string | null;
  mode: "mock" | "real";
  /** True when the API runs in a container, so the guide shows the right restart. */
  containerised: boolean;
  /** What .env says, so the UI can show when the toggle has diverged. */
  configuredMode: "mock" | "real";
  realAccountConfigured: boolean;
  roleArn: string;
  accountId: string | null;
  externalIdMasked: string;
  externalIdIsPlaceholder: boolean;
  homeRegion: string;
  regions: string[] | null;
  endpointOverride: string | null;
  lastScan: { id: string; at: string; status: string } | null;
}

export interface ConnectionTest {
  ok: boolean;
  durationMs: number;
  mode: string;
  assumedRoleArn?: string;
  accountId?: string;
  callerArn?: string | null;
  expiresAt?: string;
  endpoint?: string;
  code?: string;
  problem?: string;
  fix?: string;
}

export interface Health {
  status: string;
  checks: Record<string, string>;
  awsMode: string;
  lastScan: { id: string; at: string; status: string } | null;
}

/** What `/api/me` answers, which is everything the first frame needs. */
export interface Me {
  hosted: boolean;
  signedIn: boolean;
  user: { email: string; name: string | null; avatarUrl: string | null } | null;
  isAdmin: boolean;
  /** Their role in this workspace; null when signed out. Always owner self-hosted. */
  role: TeamRole | null;
  providers: string[];
  linked: string[];
  connections: ConnectionSummary[];
}

export type TeamRole = "owner" | "admin" | "member" | "viewer";
const RANK: Record<TeamRole, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };
/** Whether `role` may do what needs `min`, as the server's guard decides it. */
export const can = (role: TeamRole | null | undefined, min: TeamRole) =>
  role != null && RANK[role] >= RANK[min];

export interface AuditEntry {
  id: string;
  at: string;
  action: string;
  subject: string | null;
  detail: Record<string, unknown>;
  ip: string | null;
  actor: { id: string; email: string | null } | null;
}

/** A plain link rather than a fetch: the browser saves the file itself. */
export const auditExportUrl = (format: "csv" | "json") => `/api/audit/export?format=${format}`;

export interface TenantHealth {
  id: string;
  name: string;
  createdAt: string;
  members: number;
  connections: number;
  activeScans: number;
  scansFailed7d: number;
  scansSucceeded7d: number;
  lastScan: { status: string; at: string | null; error: string | null } | null;
  questions24h: number;
  tokens24h: number;
}

export interface ApiToken {
  id: string;
  name: string;
  role: TeamRole;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdBy: string;
}

export interface Team {
  you: { id: string; role: TeamRole };
  members: {
    id: string;
    email: string;
    name: string | null;
    role: TeamRole;
    joinedAt: string;
    lastSeenAt: string | null;
  }[];
  invites: {
    id: string;
    role: TeamRole;
    createdAt: string;
    expiresAt: string;
    createdBy: string | null;
  }[];
}

export interface ConnectionSummary {
  id: string;
  kind: "real" | "demo" | "organization";
  label: string;
  accountId: string | null;
  roleArn: string | null;
  status: "pending" | "verified" | "failed" | "disconnected";
  lastError: string | null;
  scanRegions: string[];
  templateVersion: string | null;
  lastVerifiedAt: string | null;
  lastScanAt: string | null;
  /** The organization connection that found this account, if one did. */
  parentId: string | null;
}

/** Everything the connect screen needs, in one request. */
export interface OnboardingPlan {
  connection: ConnectionSummary;
  externalId: string;
  scannerPrincipalArn: string;
  templateUrl: string;
  templateVersion: string;
  launchUrl: string;
  cliCommand: string;
  terraform: string;
  roleArnPattern: string;
  /** For an organization: the StackSet that puts the role in every member. */
  stackSet?: string;
}

export interface VerifyResult {
  ok: boolean;
  accountId?: string;
  assumedRoleArn?: string;
  durationMs: number;
  /** The useful part of a failure: what is wrong and what to do about it. */
  diagnosis?: { code: string; problem: string; fix: string };
  /** A refusal that is not a diagnosis — the account reached is not the one agreed. */
  problem?: string;
  /** For an organization: the accounts it found, and how each one's check went. */
  organization?: {
    found: number;
    added: number;
    departed: number;
    alreadyConnected: string[];
    members: { connectionId: string; label: string; ok: boolean; problem?: string }[];
    unchecked: number;
  };
}

export interface SessionRow {
  id: string;
  createdAt: string;
  lastUsedAt: string | null;
  userAgent: string | null;
  current: boolean;
}

/**
 * Which of the tenant's AWS accounts the UI is looking at.
 *
 * Module-level because every request carries it and threading it through each
 * call site would mean a call site that forgets. The server treats an absent
 * header as "your oldest connection", so this being null is a valid state
 * rather than an error.
 */
let connectionId: string | null = null;

export function selectConnection(id: string | null): void {
  connectionId = id;
}

export function selectedConnection(): string | null {
  return connectionId;
}

/**
 * Headers every request carries.
 *
 * `X-Sightline-Request` is the forgery check: a cross-site form cannot set a
 * custom header, and a cross-origin `fetch` that tries triggers a preflight the
 * API's CORS configuration does not answer. Sent on reads too, so there is one
 * rule rather than a list of methods to keep in step with the server's.
 */
function withHeaders(extra?: HeadersInit): HeadersInit {
  return {
    ...(extra as Record<string, string> | undefined),
    "X-Sightline-Request": "1",
    ...(connectionId ? { "X-Sightline-Connection": connectionId } : {}),
  };
}

/** The one place a request is made, so the headers cannot be left off one. */
function request(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(path, { ...init, headers: withHeaders(init.headers) });
}

/** The server's `{ error }` body if there is one, else the status line. */
/** Refused for want of a recent sign-in: the fix is to sign in again, so the UI offers it. */
export class ReauthRequired extends Error {}

async function failure(res: Response): Promise<Error> {
  const text = await res.text().catch(() => "");
  try {
    const body = JSON.parse(text) as { error?: string; reauth?: boolean };
    if (body.error) return body.reauth ? new ReauthRequired(body.error) : new Error(body.error);
  } catch {
    /* not JSON; fall through to the raw body */
  }
  return new Error(`${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
}

async function get<T>(path: string): Promise<T> {
  const res = await request(path);
  if (!res.ok) throw await failure(res);
  return res.json() as Promise<T>;
}

async function send<T>(path: string, init: RequestInit): Promise<T> {
  const res = await request(path, init);
  if (!res.ok) throw await failure(res);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const asJson = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const api = {
  health: () => get<Health>("/api/health"),
  latestScan: () =>
    get<{
      scan: ScanRun | null;
      scanning: boolean;
      /** The job to attach to, when one is in flight. Null otherwise. */
      activeJobId: string | null;
    }>("/api/scans/latest"),
  scans: () => get<{ scans: ScanRun[] }>("/api/scans"),
  summary: () => get<Summary>("/api/summary"),
  findings: () => get<Findings>("/api/findings"),
  setFindingStatus: (
    id: string,
    body: { status: "accepted"; reason: string } | { status: "open" },
  ) =>
    send<{ finding: FindingState }>(`/api/findings/${encodeURIComponent(id)}`, {
      ...asJson(body),
      method: "PATCH",
    }),
  graph: (params: { region?: string; kinds?: string[]; group?: string; limit?: number } = {}) => {
    const search = new URLSearchParams();
    if (params.region) search.set("region", params.region);
    if (params.kinds?.length) search.set("kinds", params.kinds.join(","));
    if (params.group) search.set("group", params.group);
    search.set("limit", String(params.limit ?? 500));
    return get<GraphData>(`/api/graph?${search}`);
  },
  graphGroups: () => get<{ groups: GraphGroup[] }>("/api/graph/groups"),
  graphNeighbours: (arn: string) =>
    get<GraphData>(`/api/graph/neighbours?arn=${encodeURIComponent(arn)}`),
  diff: () => get<{ diff: ScanDiff | null; reason?: string }>("/api/scans/diff"),

  checks: () => get<{ checks: Omit<CheckResult, "passed" | "detail">[] }>("/api/evals/checks"),
  latestEvalRun: () =>
    get<{ run: AgentEvalRun | null; hint?: string; currentModel?: string }>("/api/evals/latest"),
  runGroundTruth: () => send<GroundTruthRun>("/api/evals/ground-truth", { method: "POST" }),

  connection: () => get<Connection>("/api/connection"),
  newExternalId: () => get<{ externalId: string; note: string }>("/api/connection/external-id"),
  testConnection: async (): Promise<ConnectionTest> => {
    // A failed test is a 200 with `ok: false` and a diagnosis, which is the
    // useful part - so the body is read whatever the status.
    const res = await request("/api/connection/test", { method: "POST" });
    return res.json() as Promise<ConnectionTest>;
  },

  // --- identity and accounts ----------------------------------------------
  me: () => get<Me>("/api/me"),
  logout: () => send<void>("/api/auth/logout", { method: "POST" }),
  sessions: () => get<{ sessions: SessionRow[] }>("/api/auth/sessions"),
  revokeSession: (id: string) =>
    send<void>(`/api/auth/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),
  revokeAllSessions: () =>
    send<{ revoked: number }>("/api/auth/sessions/revoke-all", { method: "POST" }),

  /**
   * Delete this account and everything Sightline holds about it.
   *
   * `confirm` is the account's own email address, checked by the server. The
   * value is sent rather than a boolean so the confirmation cannot be satisfied
   * by a request that does not know it.
   */
  deleteAccount: (confirm: string) =>
    send<{ deleted?: Record<string, number>; left?: boolean; note: string }>("/api/me", {
      ...asJson({ confirm }),
      method: "DELETE",
    }),

  // --- the team -------------------------------------------------------------
  team: () => get<Team>("/api/team"),
  apiTokens: () => get<{ tokens: ApiToken[] }>("/api/tokens"),
  operatorTenants: () => get<{ tenants: TenantHealth[] }>("/api/operator/tenants"),
  createApiToken: (input: { name: string; role: TeamRole; expiresInDays: number }) =>
    send<{ id: string; token: string; expiresAt: string | null }>("/api/tokens", asJson(input)),
  revokeApiToken: (id: string) =>
    send<void>(`/api/tokens/${encodeURIComponent(id)}`, { method: "DELETE" }),
  audit: (before?: string) =>
    get<{ entries: AuditEntry[]; next: string | null }>(
      before ? `/api/audit?before=${encodeURIComponent(before)}` : "/api/audit",
    ),
  createInvite: (role: TeamRole) =>
    send<{ id: string; role: TeamRole; url: string; expiresAt: string }>(
      "/api/team/invites",
      asJson({ role }),
    ),
  revokeInvite: (id: string) =>
    send<void>(`/api/team/invites/${encodeURIComponent(id)}`, { method: "DELETE" }),
  setMemberRole: (id: string, role: TeamRole) =>
    send<void>(`/api/team/members/${encodeURIComponent(id)}`, {
      ...asJson({ role }),
      method: "PATCH",
    }),
  removeMember: (id: string) =>
    send<void>(`/api/team/members/${encodeURIComponent(id)}`, { method: "DELETE" }),
  joinTeam: (token: string) =>
    send<{ tenantId: string; role: TeamRole }>("/api/team/join", asJson({ token })),

  connections: () => get<{ connections: ConnectionSummary[] }>("/api/connections"),

  /**
   * One resource, and what fixes it.
   *
   * Through this client rather than a bare `fetch`, which is how these two
   * started life. A bare `fetch` sends no `X-Sightline-Connection`, so the
   * server fell back to the tenant's *oldest* connection - and the detail
   * panel then answered about a different AWS account than the one on screen.
   * It presented as clicking a node showing nothing, because the ARN being
   * asked about does not exist in the account that got resolved.
   *
   * Typed by the caller: each component owns the shape it renders.
   */
  resource: <T>(arn: string) => get<T>(`/api/resources/${encodeURIComponent(arn)}`),
  remediation: <T>(arn: string) => get<T>(`/api/resources/${encodeURIComponent(arn)}/remediation`),
  createConnection: (input: { label: string; kind?: "real" | "demo" | "organization" }) =>
    send<{ id: string; externalId: string; note: string }>("/api/connections", asJson(input)),
  setConnectionTarget: (id: string, accountId: string) =>
    send<{ ok: true }>(`/api/connections/${encodeURIComponent(id)}/target`, asJson({ accountId })),
  connectionOnboarding: (id: string) =>
    get<OnboardingPlan>(`/api/connections/${encodeURIComponent(id)}/onboarding`),
  verifyConnection: (id: string) =>
    send<VerifyResult>(`/api/connections/${encodeURIComponent(id)}/verify`, { method: "POST" }),
  disconnect: (id: string) =>
    send<{ ok: true; note: string }>(`/api/connections/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
};

/**
 * Consume a server-sent event stream from a POST.
 *
 * `EventSource` only does GET, and both of these endpoints need a body or are
 * semantically a command, so the stream is read off `fetch` directly. The
 * buffering below matters: a chunk boundary can land mid-event, and parsing
 * per-chunk would silently drop those.
 */
async function streamPost<E>(
  path: string,
  body: unknown,
  onEvent: (event: E) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await request(path, {
    ...asJson(body),
    ...(signal ? { signal } : {}),
  });
  await consume(res, onEvent);
}

/**
 * The same, for a stream behind a GET.
 *
 * Which is how a scan already in flight is rejoined: the scan is no longer tied
 * to the request that asked for it, so attaching to one is a read rather than a
 * command. Still `fetch` and not `EventSource`, because `EventSource` cannot
 * send the connection header this API scopes requests with.
 */
async function streamGet<E>(
  path: string,
  onEvent: (event: E) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await request(path, { ...(signal ? { signal } : {}) });
  await consume(res, onEvent);
}

async function consume<E>(res: Response, onEvent: (event: E) => void): Promise<void> {
  if (!res.ok) {
    const text = await res.text();
    let message = text;
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {
      /* not JSON; use the raw body */
    }
    throw new Error(message);
  }
  if (!res.body) throw new Error("Response carried no body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Events are separated by a blank line; anything after the last one is an
    // incomplete event and stays in the buffer.
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      const line = part.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      try {
        onEvent(JSON.parse(line.slice(6)) as E);
      } catch {
        /* a malformed frame should not kill the stream */
      }
    }
  }
}

/**
 * Ask for a scan and watch it, or attach to the one already running.
 *
 * A 409 means somebody - another tab, or this user a moment ago - already
 * started one. That is not an error worth showing: the scan they wanted is
 * happening, so this attaches to it. The response carries the job's id for
 * exactly this purpose.
 */
export async function startScan(
  onEvent: (event: ScanEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await request("/api/scans", {
    ...asJson({}),
    ...(signal ? { signal } : {}),
  });

  if (res.status === 409) {
    const body = (await res.json()) as { activeJobId?: string | null; error?: string };
    if (body.activeJobId) return watchScan(body.activeJobId, onEvent, signal);
    throw new Error(body.error ?? "A scan is already running");
  }

  await consume(res, onEvent);
}

/**
 * Watch a scan that is already running.
 *
 * What makes a reload harmless: `latestScan` names the active job, and this
 * picks it up from wherever it has got to - including the full unit list as it
 * currently stands, so the page looks like the page that never reloaded.
 */
export const watchScan = (
  jobId: string,
  onEvent: (event: ScanEvent) => void,
  signal?: AbortSignal,
) => streamGet<ScanEvent>(`/api/scans/jobs/${encodeURIComponent(jobId)}/stream`, onEvent, signal);

export const askAgent = (
  question: string,
  conversationId: string | undefined,
  onEvent: (event: AgentEvent) => void,
  signal?: AbortSignal,
) =>
  streamPost<AgentEvent>(
    "/api/chat",
    conversationId ? { question, conversationId } : { question },
    onEvent,
    signal,
  );

export type { AgentEvent, AgentMessage, ScanEvent, ScanRun, ScanDiff };
