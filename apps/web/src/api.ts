/** API client. Thin on purpose - the interesting logic lives server-side. */

import type { AgentEvent, AgentMessage, ScanDiff, ScanEvent, ScanRun } from "@daveio/shared";

export interface GraphNode {
  arn: string;
  kind: string;
  name: string;
  region: string | null;
  isPublic?: boolean | null;
  isAdmin?: boolean | null;
  isIdle?: boolean | null;
  isUnprotected?: boolean | null;
  estimatedMonthlyCostUsd?: number | null;
  reason?: string | null;
}

export interface GraphEdge {
  from: string;
  to: string;
  type: string;
  ports?: string | null;
}

export interface Summary {
  byKind: Array<{ kind: string; count: number }>;
  byRegion: Array<{ region: string; count: number }>;
  publicCount: number;
  adminCount: number;
  idleCount: number;
  idleCost: number;
  unprotectedCount: number;
}

export interface Findings {
  publicResources: GraphNode[];
  /** Not public, but nothing would stop them becoming public. */
  unprotected: GraphNode[];
  adminRoles: Array<GraphNode & { reason?: string; usedBy?: GraphNode[]; useCount?: number }>;
  idle: GraphNode[];
  exposed: Array<GraphNode & { ports?: string[]; securityGroup?: string }>;
}

export interface CheckResult {
  id: string;
  description: string;
  rationale: string;
  passed: boolean;
  detail: string;
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
}

export interface AgentEvalRun {
  id: string;
  startedAt: string;
  model: string;
  total: number;
  passed: number;
  meanF1: number;
  unsupportedCitations: number;
  cases: AgentEvalCase[];
}

export interface Connection {
  /** The identity this backend runs as, which the trust policy must name. */
  callerIdentity: string | null;
  mode: "mock" | "real";
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

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: () => get<Health>("/api/health"),
  latestScan: () => get<{ scan: ScanRun | null; scanning: boolean }>("/api/scans/latest"),
  scans: () => get<{ scans: ScanRun[] }>("/api/scans"),
  summary: () => get<Summary>("/api/summary"),
  findings: () => get<Findings>("/api/findings"),
  graph: (params: { region?: string; kinds?: string[] } = {}) => {
    const search = new URLSearchParams();
    if (params.region) search.set("region", params.region);
    if (params.kinds?.length) search.set("kinds", params.kinds.join(","));
    search.set("limit", "500");
    return get<{ nodes: GraphNode[]; edges: GraphEdge[] }>(`/api/graph?${search}`);
  },
  diff: () => get<{ diff: ScanDiff | null; reason?: string }>("/api/scans/diff"),

  checks: () => get<{ checks: Array<Omit<CheckResult, "passed" | "detail">> }>("/api/evals/checks"),
  latestEvalRun: () =>
    get<{ run: AgentEvalRun | null; hint?: string; currentModel?: string }>("/api/evals/latest"),
  runGroundTruth: async (): Promise<GroundTruthRun> => {
    const res = await fetch("/api/evals/ground-truth", { method: "POST" });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `${res.status} ${res.statusText}`);
    }
    return res.json() as Promise<GroundTruthRun>;
  },

  connection: () => get<Connection>("/api/connection"),
  setMode: async (mode: "mock" | "real") => {
    const res = await fetch("/api/connection/mode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    const body = (await res.json()) as { error?: string; note?: string; accountId?: string };
    if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
    return body;
  },
  newExternalId: () => get<{ externalId: string; note: string }>("/api/connection/external-id"),
  testConnection: async (): Promise<ConnectionTest> => {
    const res = await fetch("/api/connection/test", { method: "POST" });
    return res.json() as Promise<ConnectionTest>;
  },
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
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });

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

export const startScan = (onEvent: (event: ScanEvent) => void, signal?: AbortSignal) =>
  streamPost<ScanEvent>("/api/scans", {}, onEvent, signal);

export const askAgent = (
  question: string,
  history: Array<{ role: "user" | "assistant"; content: string }>,
  onEvent: (event: AgentEvent) => void,
  signal?: AbortSignal,
) => streamPost<AgentEvent>("/api/chat", { question, history }, onEvent, signal);

export type { AgentEvent, AgentMessage, ScanEvent, ScanRun, ScanDiff };
