/**
 * Every route this API serves, with the shape of each response it can give.
 *
 * The contract test (contract.test.ts) calls each one against the real app and
 * holds its answer to these shapes; the OpenAPI document (cli/openapi.ts) is
 * written from them. One list, so the published description of the API is the
 * one the tests enforce. `url` and `payload` are the request the test makes.
 */

import { randomUUID } from "node:crypto";
import * as api from "@sightline/shared/api";
import { z } from "zod";

const error = z.object({ error: z.string() }).strict();
const errorWithCode = z.object({ error: z.string(), code: z.string() }).strict();

const scan = z.object({
  id: z.string(),
  accountId: z.string(),
  status: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  regions: z.array(z.string()),
  units: z.array(z.unknown()),
  resourceCount: z.number(),
  relationshipCount: z.number(),
});

export interface Contract {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** The path as Fastify registers it, with `:params`. Keyed against the router. */
  route: string;
  /** A concrete URL to call. */
  url: string;
  payload?: Record<string, unknown>;
  /** Every response this endpoint may produce, by status. */
  responses: Record<number, z.ZodTypeAny>;
  /**
   * Why this endpoint is called with input that makes it refuse.
   *
   * Three of them must not be exercised for real: one spends money, one
   * switches the deployment's AWS account underneath whoever is using it, and
   * one runs a full scan. Their rejection path is still a contract - the UI
   * renders it - so it is what gets pinned, and the comment says so rather
   * than leaving a reader to wonder why the test looks lazy.
   */
  refusedOnPurpose?: string;
}

const UNKNOWN_ARN = `arn:aws:s3:::contract-test-${randomUUID().slice(0, 8)}`;
const UNKNOWN_ID = randomUUID();

export const CONTRACTS: Contract[] = [
  {
    method: "GET",
    route: "/api/health",
    url: "/api/health",
    responses: { 200: api.health },
  },
  {
    method: "GET",
    route: "/api/scans",
    url: "/api/scans",
    responses: { 200: z.object({ scans: z.array(scan) }).strict() },
  },
  {
    method: "GET",
    route: "/api/scans/latest",
    url: "/api/scans/latest",
    responses: {
      200: z
        .object({
          scan: scan.nullable(),
          scanning: z.boolean(),
          /**
           * The job a reloaded page attaches to.
           *
           * `scanning` alone was enough while a scan lived inside the request
           * that started it, because the only client that could be watching
           * was the one holding that response open.
           */
          activeJobId: z.string().nullable(),
        })
        .strict(),
    },
  },
  {
    method: "GET",
    route: "/api/scans/jobs/:jobId",
    // A well-formed id nobody owns, which is the declinable path: a real job's
    // 200 needs a scan to have run, and the 404 is what the UI renders when a
    // remembered job id has aged out.
    url: `/api/scans/jobs/${UNKNOWN_ID}`,
    responses: {
      200: z
        .object({
          status: z.string(),
          queuedAt: z.string(),
          scanId: z.string().nullable(),
          run: scan.nullable(),
          error: z.string().nullable(),
        })
        .strict(),
      404: error,
    },
  },
  {
    method: "DELETE",
    route: "/api/scans/jobs/:jobId",
    url: `/api/scans/jobs/${UNKNOWN_ID}`,
    responses: {
      // Cancelling something that is not queued is not an error: it answers
      // what actually happened, which is how the UI can say so.
      200: z.object({ cancelled: z.boolean(), note: z.string().optional() }).strict(),
    },
  },
  {
    method: "GET",
    route: "/api/webhook",
    url: "/api/webhook",
    responses: { 200: api.webhookView },
  },
  {
    method: "GET",
    route: "/api/findings/page",
    url: "/api/findings/page?list=idle&offset=0",
    responses: { 200: api.findingsPage, 400: error },
  },
  {
    method: "GET",
    route: "/api/findings/accounts",
    url: "/api/findings/accounts",
    responses: { 200: api.acrossAccounts },
  },
  {
    method: "GET",
    route: "/api/operator/tenants",
    url: "/api/operator/tenants",
    responses: { 200: api.tenantHealthList },
  },
  {
    method: "GET",
    route: "/api/audit",
    url: "/api/audit",
    responses: { 200: api.auditPage },
  },
  {
    method: "GET",
    route: "/api/audit/export",
    url: "/api/audit/export?format=json",
    responses: { 200: api.auditExport },
  },
  {
    method: "GET",
    route: "/api/scans/diff",
    url: "/api/scans/diff",
    responses: {
      // `reason` appears only when there is nothing to compare, so the two
      // shapes are a union rather than one schema with an optional field.
      200: z.union([
        z
          .object({
            diff: z.object({
              fromScanId: z.string(),
              toScanId: z.string(),
              fromScanAt: z.string(),
              toScanAt: z.string(),
              added: z.array(z.unknown()),
              removed: z.array(z.unknown()),
              modified: z.array(z.unknown()),
            }),
          })
          .strict(),
        z.object({ diff: z.null(), reason: z.string() }).strict(),
      ]),
      404: error,
    },
  },
  {
    method: "GET",
    route: "/api/scans/:id",
    url: `/api/scans/${UNKNOWN_ID}`,
    responses: { 200: z.object({ scan }).strict(), 404: error },
  },
  {
    method: "GET",
    route: "/api/summary",
    url: "/api/summary",
    responses: { 200: api.summary },
  },
  {
    method: "GET",
    route: "/api/search",
    url: "/api/search?q=prod",
    responses: { 200: api.searchResults },
  },
  {
    method: "GET",
    route: "/api/graph",
    url: "/api/graph?limit=5",
    responses: { 200: api.graphData },
  },
  {
    method: "GET",
    route: "/api/graph/groups",
    url: "/api/graph/groups",
    responses: { 200: api.graphGroups },
  },
  {
    method: "GET",
    route: "/api/graph/neighbours",
    url: `/api/graph/neighbours?arn=${encodeURIComponent(UNKNOWN_ARN)}`,
    responses: { 200: api.graphData },
  },
  {
    method: "GET",
    route: "/api/resources/:arn",
    url: `/api/resources/${encodeURIComponent(UNKNOWN_ARN)}`,
    responses: { 200: z.object({ resource: z.unknown() }).passthrough(), 404: error },
  },
  {
    method: "GET",
    route: "/api/resources/:arn/remediation",
    url: `/api/resources/${encodeURIComponent(UNKNOWN_ARN)}/remediation`,
    responses: { 200: z.object({}).passthrough(), 404: error },
  },
  {
    method: "GET",
    route: "/api/findings",
    url: "/api/findings",
    responses: { 200: api.findings },
  },
  {
    method: "PATCH",
    route: "/api/findings/:id",
    url: `/api/findings/${UNKNOWN_ID}`,
    payload: { status: "accepted", reason: "Hosts the public website" },
    responses: {
      200: z.object({ finding: z.object({ id: z.string(), status: z.string() }) }).strict(),
      400: z.object({ error: z.string(), details: z.unknown() }).strict(),
      404: error,
    },
  },
  {
    method: "POST",
    route: "/api/chat",
    url: "/api/chat",
    payload: {},
    refusedOnPurpose:
      "answering calls the model, which costs money on every run of the suite. The " +
      "validation rejection is the contract the UI renders for an empty question, and " +
      "the answer path is covered by the 21 agent eval cases instead.",
    responses: {
      400: z.object({ error: z.string(), details: z.unknown() }).strict(),
    },
  },
  {
    method: "GET",
    route: "/api/conversations/:id",
    url: `/api/conversations/${UNKNOWN_ID}`,
    responses: { 200: z.object({ messages: z.array(z.unknown()) }).strict() },
  },
  {
    method: "GET",
    route: "/api/connection",
    url: "/api/connection",
    responses: { 200: api.connection },
  },
  {
    method: "POST",
    route: "/api/connection/mode",
    url: "/api/connection/mode",
    payload: { mode: "contract-test-not-a-mode" },
    refusedOnPurpose:
      "a valid body switches the running deployment between the mock and the real " +
      "account and drops the cached STS session, so a test that called it would " +
      "reconfigure whoever is using the app at the time.",
    responses: { 400: error },
  },
  {
    method: "GET",
    route: "/api/connection/external-id",
    url: "/api/connection/external-id",
    responses: {
      200: z.object({ externalId: z.string(), note: z.string() }).strict(),
    },
  },
  {
    // Safe to call for real: one `sts:GetCallerIdentity` and one AssumeRole
    // attempt, both read-only, and a failure is reported as `ok: false` with a
    // diagnosis rather than thrown - so this stays a shape assertion whether or
    // not the machine running it has working AWS credentials.
    method: "POST",
    route: "/api/connection/test",
    url: "/api/connection/test",
    payload: {},
    responses: { 200: api.connectionTest },
  },
  {
    method: "POST",
    route: "/api/evals/ground-truth",
    url: "/api/evals/ground-truth",
    payload: {},
    refusedOnPurpose:
      "in mock mode this re-seeds the account and runs a full scan; in real mode it " +
      "refuses, because the expected answers describe the fixture. Both refusals are " +
      "contracts the Trust panel renders, and the checks themselves are covered by " +
      "the tier-1 suite.",
    responses: {
      200: z.object({ results: z.array(z.unknown()) }).passthrough(),
      409: errorWithCode,
    },
  },
  {
    method: "GET",
    route: "/api/evals/checks",
    url: "/api/evals/checks",
    responses: { 200: api.checkList },
  },
  {
    method: "GET",
    route: "/api/evals/latest",
    url: "/api/evals/latest",
    responses: { 200: api.latestEvalRun },
  },
];

CONTRACTS.push(
  {
    method: "GET",
    route: "/api/auth/providers",
    url: "/api/auth/providers",
    responses: {
      200: z.object({ providers: z.array(z.string()), hosted: z.boolean() }).strict(),
    },
  },
  {
    method: "GET",
    route: "/api/me",
    url: "/api/me",
    responses: { 200: api.me },
  },
  {
    // A team exists only in hosted mode; this suite runs self-hosted, where
    // the answer is a refusal. The rules are auth/team.test.ts.
    method: "GET",
    route: "/api/team",
    url: "/api/team",
    responses: { 400: error },
  },
  {
    method: "GET",
    route: "/api/connections",
    url: "/api/connections",
    responses: { 200: api.connectionList },
  },
);

/**
 * Routes with no contract here, each with why: calling them in a test would
 * spend money, touch an outside system, or destroy something. They are still
 * in the OpenAPI document, marked as not shape-tested.
 */
export const EXCLUDED = new Map<string, string>([
  [
    "PUT /api/webhook",
    "Sends to, or changes, an outside URL; a contract run would post to somebody's chat. " +
      "Refusing unsafe URLs is integrations/webhook.test.ts, who may call it auth/enforcement.test.ts.",
  ],
  [
    "DELETE /api/webhook",
    "Sends to, or changes, an outside URL; a contract run would post to somebody's chat. " +
      "Refusing unsafe URLs is integrations/webhook.test.ts, who may call it auth/enforcement.test.ts.",
  ],
  [
    "POST /api/webhook/test",
    "Sends to, or changes, an outside URL; a contract run would post to somebody's chat. " +
      "Refusing unsafe URLs is integrations/webhook.test.ts, who may call it auth/enforcement.test.ts.",
  ],
  [
    "GET /api/tokens",
    "Hosted only: this suite runs self-hosted, where there is no sign-in for a token to " +
      "stand for. What a token may and may not do is auth/enforcement.test.ts, against the real app.",
  ],
  [
    "POST /api/tokens",
    "Hosted only: this suite runs self-hosted, where there is no sign-in for a token to " +
      "stand for. What a token may and may not do is auth/enforcement.test.ts, against the real app.",
  ],
  [
    "DELETE /api/tokens/:id",
    "Hosted only: this suite runs self-hosted, where there is no sign-in for a token to " +
      "stand for. What a token may and may not do is auth/enforcement.test.ts, against the real app.",
  ],
  [
    "POST /api/team/invites",
    "Hosted only: this suite runs self-hosted, where every team route refuses. The " +
      "rules - invites used once, roles within what the actor may grant, an owner always kept - " +
      "are auth/team.test.ts against Postgres, and who may call each is auth/enforcement.test.ts.",
  ],
  [
    "DELETE /api/team/invites/:id",
    "Hosted only: this suite runs self-hosted, where every team route refuses. The " +
      "rules - invites used once, roles within what the actor may grant, an owner always kept - " +
      "are auth/team.test.ts against Postgres, and who may call each is auth/enforcement.test.ts.",
  ],
  [
    "PATCH /api/team/members/:id",
    "Hosted only: this suite runs self-hosted, where every team route refuses. The " +
      "rules - invites used once, roles within what the actor may grant, an owner always kept - " +
      "are auth/team.test.ts against Postgres, and who may call each is auth/enforcement.test.ts.",
  ],
  [
    "DELETE /api/team/members/:id",
    "Hosted only: this suite runs self-hosted, where every team route refuses. The " +
      "rules - invites used once, roles within what the actor may grant, an owner always kept - " +
      "are auth/team.test.ts against Postgres, and who may call each is auth/enforcement.test.ts.",
  ],
  [
    "POST /api/team/join",
    "Hosted only: this suite runs self-hosted, where every team route refuses. The " +
      "rules - invites used once, roles within what the actor may grant, an owner always kept - " +
      "are auth/team.test.ts against Postgres, and who may call each is auth/enforcement.test.ts.",
  ],
  [
    "POST /api/scans",
    "Queues a real scan, then streams it. There is no input that makes it decline - its " +
      "409 needs a scan already queued, and reaching that state means having queued one - " +
      "so calling it would scan whichever AWS account the deployment is pointed at and " +
      "overwrite the graph. The events are covered by jobs/progress.test.ts, which seeds " +
      "the rows they are derived from, and typed as `ScanEvent` in @sightline/shared, so " +
      "a port that changes them fails typecheck. The queue itself is jobs/queue.test.ts.",
  ],
  [
    "GET /api/scans/jobs/:jobId/stream",
    "An event stream, so it has no single response body to declare, and it stays open " +
      "until the scan ends. What it emits is asserted directly in jobs/progress.test.ts " +
      "by seeding the rows the events are derived from - which is possible precisely " +
      "because the stream is now a function of the database rather than of a live scan.",
  ],
  [
    "GET /api/auth/:provider",
    "A 302 to the provider's consent screen. There is no body to have a shape, and the " +
      "query string it builds is asserted directly in auth/providers.test.ts.",
  ],
  [
    "GET /api/auth/:provider/callback",
    "A 302 either into the app or back to it with a reason. Every branch is a redirect, " +
      "and the claim checks behind it are asserted in auth/providers.test.ts without a " +
      "network.",
  ],
  [
    "POST /api/auth/logout",
    "204 and a cleared cookie: no body to declare. Revocation is asserted against real " +
      "rows in auth/signin.test.ts.",
  ],
  [
    "GET /api/auth/sessions",
    "Session management has no meaning in a self-hosted deployment, which has no " +
      "sessions, and this suite runs self-hosted. Covered by auth/signin.test.ts.",
  ],
  [
    "DELETE /api/me",
    "Deletes the account and everything in it. Not exercised here for the obvious reason - " +
      "this suite runs against a populated database and the refusal path it *can* reach " +
      "(self-hosted has no account to delete) is the uninteresting half. The purge itself is " +
      "asserted in tenancy/purge.test.ts, which seeds two tenants, deletes one, and checks both " +
      "that nothing of it remains and that the other is untouched.",
  ],
  [
    "POST /api/auth/sessions/revoke-all",
    "Revokes every session for the caller. Covered by auth/signin.test.ts, which asserts " +
      "each token is dead afterwards.",
  ],
  [
    "DELETE /api/auth/sessions/:id",
    "Revokes one session, scoped to its owner. Covered by auth/signin.test.ts.",
  ],
  [
    "POST /api/connections",
    "Creates a connection and returns an ExternalId that is shown once. Calling it here " +
      "would leave rows behind and put a one-time secret in a test log; the behaviour is " +
      "covered by the tenancy suites.",
  ],
  [
    "POST /api/connections/:id/target",
    "Writes a role ARN derived from an account id. Mutating, and the derivation is " +
      "asserted in packages/shared's onboarding tests.",
  ],
  [
    "GET /api/connections/:id/onboarding",
    "Returns a one-click link carrying the connection's ExternalId. Needs a real " +
      "connection to exist and would put that secret in a test log; the link's shape is " +
      "asserted in packages/shared's onboarding tests, which need no database.",
  ],
  [
    "POST /api/connections/:id/verify",
    "Attempts a real sts:AssumeRole into a customer account. Read-only, but it is still " +
      "an outbound call per invocation, and the diagnosis it returns is asserted in " +
      "connection/credentialDiagnosis.test.ts against the error shapes AWS produces.",
  ],
  [
    "DELETE /api/connections/:id",
    "Forgets a connection and purges its graph scopes. Destructive by design, so it is " +
      "exercised where the rows are disposable rather than against the running app.",
  ],
]);

/** What each route that takes a body accepts, by `METHOD /route`. */
export const REQUEST_BODIES = new Map<string, z.ZodType>([
  ["POST /api/chat", api.askRequest],
  ["PATCH /api/findings/:id", api.findingStatusRequest],
  ["POST /api/tokens", api.tokenCreateRequest],
  ["POST /api/connections", api.connectionCreateRequest],
  ["POST /api/connections/:id/target", api.connectionTargetRequest],
  ["POST /api/team/invites", api.teamRoleRequest],
  ["PATCH /api/team/members/:id", api.teamRoleRequest],
  ["POST /api/team/join", api.teamJoinRequest],
]);
