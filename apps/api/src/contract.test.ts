/**
 * HTTP contract tests: the shape of every response this API can produce.
 *
 * Written as the safety net for a refactor, not as unit tests of the handlers.
 * The data layer is moving to an ORM and the HTTP layer to a structured
 * framework, and the one property that must survive both is that the frontend
 * sees byte-compatible payloads. Nothing asserted that before: the suite had
 * 424 tests and exactly one of them issued an HTTP request.
 *
 * Three decisions worth knowing before changing this file.
 *
 * **The schemas were captured, not written.** Every endpoint was called against
 * a populated database and its real response recorded; the schemas below
 * describe what came back. A contract invented from reading the handlers would
 * pin what I believed the API returned, which is the same source of error the
 * refactor is trying to protect against.
 *
 * **Top level is `.strict()`, nested shapes are not.** A rename or a dropped
 * field at the top level is exactly the regression a port introduces, so an
 * unexpected key there is a failure. Inside arrays the entries are only checked
 * for the keys that are known to matter, because pinning every nested field
 * would make this fail on changes nobody cares about and it would then be
 * deleted rather than fixed.
 *
 * **Every status an endpoint can return is declared, and any of them passes.**
 * A contract test has to be deterministic, and these responses legitimately
 * differ with the state of the database and with `AWS_MODE` - a scan exists or
 * does not, the mock is active or is not. Asserting one status would make the
 * suite a function of the machine it runs on. Asserting "one of these, and it
 * matches that one's schema" keeps it honest and still catches a port that
 * changes a payload.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { buildApp } from "./app.js";

/**
 * Issuing a request runs the real handler against Postgres and Neo4j - a
 * contract test that stubbed them would not prove the route is reachable in the
 * product. Same gate, and the same reasoning, as `graph/resourceArn.test.ts`.
 */
const HAS_INFRA = !process.env["SKIP_INTEGRATION"];

const error = z.object({ error: z.string() }).strict();
const errorWithCode = z.object({ error: z.string(), code: z.string() }).strict();

/** A resource as every list endpoint renders it. Nested, so not strict. */
const node = z.object({
  arn: z.string(),
  kind: z.string(),
  name: z.string(),
  region: z.string().nullable(),
});

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

interface Contract {
  method: "GET" | "POST";
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

const CONTRACTS: Contract[] = [
  {
    method: "GET",
    route: "/api/health",
    url: "/api/health",
    responses: {
      200: z
        .object({
          status: z.string(),
          checks: z.object({ postgres: z.string(), neo4j: z.string(), agent: z.string() }).strict(),
          awsMode: z.string(),
          lastScan: z.object({ id: z.string(), at: z.string(), status: z.string() }).nullable(),
        })
        .strict(),
    },
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
      200: z.object({ scan: scan.nullable(), scanning: z.boolean() }).strict(),
    },
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
    responses: {
      200: z
        .object({
          byKind: z.array(z.object({ kind: z.string(), count: z.number() })),
          byRegion: z.array(z.object({ region: z.string(), count: z.number() })),
          publicCount: z.number(),
          adminCount: z.number(),
          idleCount: z.number(),
          unprotectedCount: z.number(),
          idleCost: z.number(),
        })
        .strict(),
    },
  },
  {
    method: "GET",
    route: "/api/search",
    url: "/api/search?q=prod",
    responses: { 200: z.object({ results: z.array(node) }).strict() },
  },
  {
    method: "GET",
    route: "/api/graph",
    url: "/api/graph?limit=5",
    responses: {
      200: z
        .object({
          nodes: z.array(node),
          edges: z.array(z.object({ from: z.string(), to: z.string(), type: z.string() })),
        })
        .strict(),
    },
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
    responses: {
      200: z
        .object({
          publicResources: z.array(node.extend({ reason: z.string() })),
          adminPrincipals: z.array(node.extend({ reason: z.string() })),
          idle: z.array(
            node.extend({ reason: z.string(), estimatedMonthlyCostUsd: z.number().nullable() }),
          ),
          exposed: z.array(node.extend({ reason: z.string() })),
          unprotected: z.array(node.extend({ reason: z.string(), isPublic: z.boolean() })),
        })
        .strict(),
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
    responses: {
      200: z
        .object({
          callerIdentity: z.string().nullable(),
          callerIdentityIsMock: z.boolean(),
          scannerPrincipal: z.string().nullable(),
          scannerPrincipalConverted: z.boolean(),
          scannerPrincipalNote: z.string().nullable(),
          roleArnProblem: z.string().nullable(),
          containerised: z.boolean(),
          mode: z.string(),
          configuredMode: z.string(),
          realAccountConfigured: z.boolean(),
          roleArn: z.string().nullable(),
          accountId: z.string().nullable(),
          externalIdMasked: z.string().nullable(),
          externalIdIsPlaceholder: z.boolean(),
          homeRegion: z.string(),
          regions: z.array(z.string()),
          endpointOverride: z.string().nullable(),
          lastScan: z.object({ id: z.string(), at: z.string(), status: z.string() }).nullable(),
        })
        .strict(),
    },
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
    responses: {
      200: z
        .object({
          ok: z.boolean(),
          durationMs: z.number(),
          mode: z.string(),
          callerIdentity: z.string().nullable(),
          code: z.string().optional(),
          problem: z.string().optional(),
          fix: z.string().optional(),
        })
        .passthrough(),
    },
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
    responses: {
      200: z
        .object({
          checks: z.array(
            z.object({ id: z.string(), description: z.string(), rationale: z.string() }),
          ),
        })
        .strict(),
    },
  },
  {
    method: "GET",
    route: "/api/evals/latest",
    url: "/api/evals/latest",
    responses: {
      200: z
        .object({
          run: z
            .object({
              id: z.string(),
              startedAt: z.string(),
              model: z.string(),
              total: z.number(),
              passed: z.number(),
              graded: z.number(),
              errored: z.number(),
              meanF1: z.number(),
              unsupportedCitations: z.number(),
              cases: z.array(z.unknown()),
            })
            .nullable(),
          currentModel: z.string(),
        })
        .strict(),
    },
  },
];

/**
 * Routes that cannot be contract-tested without doing real work, and what
 * covers them instead.
 *
 * Kept as data rather than as an omission, because an endpoint quietly absent
 * from a list of "every endpoint" is the thing this file exists to prevent. The
 * completeness check below accepts an entry here, and a second check refuses an
 * entry whose reason is a placeholder.
 */
const EXCLUDED = new Map<string, string>([
  [
    "POST /api/scans",
    "Starts a real scan. Its only refusal is 409 when one is already running, and " +
      "`scanInProgress` is module-private, so there is no input that makes it decline: " +
      "calling it would scan whichever AWS account the deployment is pointed at and " +
      "overwrite the graph. The scan itself is covered by the tier-1 ground-truth " +
      "suite, which drives `runScan()` directly, and the SSE payloads are typed as " +
      "`ScanEvent` in @daveio/shared, so a port that changes them fails typecheck.",
  ],
]);

let app: NestFastifyApplication;

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  if (app) await app.close();
});

describe.runIf(HAS_INFRA)("every endpoint returns a declared shape", () => {
  it.each(CONTRACTS.map((c) => [`${c.method} ${c.route}`, c] as const))("%s", async (_name, c) => {
    const res = await app.inject({
      method: c.method,
      url: c.url,
      ...(c.payload ? { payload: c.payload } : {}),
    });

    const declared = Object.keys(c.responses).map(Number);
    expect(
      declared,
      `${c.method} ${c.route} returned ${res.statusCode}, which is not a declared response. ` +
        `Body: ${res.body.slice(0, 300)}`,
    ).toContain(res.statusCode);

    const parsed = c.responses[res.statusCode]!.safeParse(res.json());
    expect(
      parsed.success ? null : JSON.stringify(parsed.error.issues, null, 2),
      `${c.method} ${c.route} responded ${res.statusCode} with a body that does not match its ` +
        "contract. If this is a deliberate API change, update the schema here and the frontend " +
        "that reads it; if it is a refactor, the refactor changed the payload.",
    ).toBeNull();
  });
});

/**
 * Every registered route has a contract, and every contract is a real route.
 *
 * Read from Fastify's own router rather than from the source, so a route added
 * through any path is in scope. Without this the suite would keep passing as
 * endpoints were added to it untested - which is the state this file was
 * written to end, and the failure mode of every "remember to add a test" rule.
 *
 * Both directions: an unlisted route is an untested payload, and a contract for
 * a route that no longer exists is a test asserting nothing while looking like
 * coverage.
 */
describe("the contract list is complete", () => {
  /** Fastify prints a tree; children carry their parent's prefix. */
  function registeredRoutes(tree: string): Set<string> {
    const found = new Set<string>();
    const stack: string[] = [];
    for (const line of tree.split("\n")) {
      const m = /^([\s│]*)(?:├──|└──)\s(\S+)\s\(([^)]+)\)\s*$/.exec(line);
      if (!m) continue;
      const depth = Math.floor(m[1]!.length / 4);
      stack.length = depth;
      stack[depth] = m[2]!;
      const path = stack.join("");
      for (const method of m[3]!.split(",").map((s) => s.trim())) {
        // HEAD is generated for every GET, and OPTIONS is the CORS plugin's
        // wildcard. Neither is a payload anyone depends on.
        if (method === "HEAD" || method === "OPTIONS") continue;
        found.add(`${method} ${path}`);
      }
    }
    return found;
  }

  it("parses the router, so the comparison below is comparing something", () => {
    // Without this, a change to Fastify's tree format would silently produce an
    // empty set and make both assertions below pass by finding nothing.
    const routes = registeredRoutes(
      app.getHttpAdapter().getInstance().printRoutes({ commonPrefix: false }),
    );
    expect(
      routes.size,
      "no routes parsed out of printRoutes — has the format changed?",
    ).toBeGreaterThan(10);
    expect(routes).toContain("GET /api/health");
    expect(routes).toContain("POST /api/chat");
  });

  it("covers every registered route, and lists none that do not exist", () => {
    const routes = registeredRoutes(
      app.getHttpAdapter().getInstance().printRoutes({ commonPrefix: false }),
    );
    const covered = new Set([
      ...CONTRACTS.map((c) => `${c.method} ${c.route}`),
      ...EXCLUDED.keys(),
    ]);

    const uncovered = [...routes].filter((r) => !covered.has(r)).sort();
    const stale = [...covered].filter((c) => !routes.has(c)).sort();

    expect(
      uncovered,
      "these routes have no contract, so a refactor could change their payload without " +
        "failing a test. Add an entry to CONTRACTS, or to EXCLUDED with a reason.",
    ).toEqual([]);
    expect(
      stale,
      "these contracts name routes that are no longer registered. Remove them — a " +
        "contract for a route that does not exist is coverage that asserts nothing.",
    ).toEqual([]);
  });

  it("gives a reason for every exclusion", () => {
    // An exclusion list is only honest while each entry says why. Without this,
    // the cheapest way to make the check above pass is to add a route to
    // EXCLUDED and move on, which converts the guard into a formality.
    const unexplained = [...EXCLUDED].filter(([, why]) => why.trim().length < 40).map(([r]) => r);
    expect(unexplained, "every excluded route needs a reason, not a placeholder").toEqual([]);
  });
});

/**
 * Every POST answers the status it answered before the framework arrived.
 *
 * Nest replies 201 to a POST unless told otherwise. Three endpoints here used
 * to answer 200, and moving them into controllers silently changed all three.
 * The contract above caught exactly one — `POST /api/connection/test`, the only
 * one whose success path it is safe to exercise. The other two are pinned on
 * their refusal path, so a changed success status sailed straight past.
 *
 * Reading the source closes that gap for the whole class rather than for the
 * two instances: a POST either declares its status, or hands the response to
 * Fastify through `@Res()` and sets it on the raw socket itself.
 */
describe("POST handlers declare their status code", () => {
  const SRC = fileURLToPath(new URL("./", import.meta.url));

  function controllerFiles(): string[] {
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".controller.ts")) found.push(path);
      }
    };
    walk(SRC);
    return found;
  }

  it("finds the controllers, so the check below has something to read", () => {
    expect(controllerFiles().length, "no *.controller.ts found").toBeGreaterThan(3);
  });

  it("gives every POST an explicit status or a raw reply", () => {
    const undeclared: string[] = [];
    for (const file of controllerFiles()) {
      const source = readFileSync(file, "utf8");
      // Each @Post and everything up to the end of its signature.
      for (const match of source.matchAll(/@Post\([^)]*\)([\s\S]*?)\)\s*\{/g)) {
        const block = match[0];
        if (block.includes("@HttpCode(") || block.includes("@Res(")) continue;
        undeclared.push(`${file.split("/src/")[1]}: ${block.split("\n")[0]}`);
      }
    }
    expect(
      undeclared,
      "these POST handlers will answer Nest's default 201. If that is what the " +
        "frontend expects, say so with @HttpCode(201); if it expects 200, add " +
        "@HttpCode(200). A raw @Res() handler sets its own status and is exempt.",
    ).toEqual([]);
  });
});
