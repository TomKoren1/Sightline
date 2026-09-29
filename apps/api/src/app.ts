/**
 * The Fastify application: every route, no listener.
 *
 * Split out of `server.ts` so the HTTP layer can be exercised with
 * `app.inject()` in a test. It could not be before — importing `server.ts` also
 * bound a port — which is why a routing bug reached a user: clicking an IAM
 * role in a real account returned HTTP 414, and nothing in the suite could have
 * issued a request to notice (engineering log #37).
 */

import { existsSync } from "node:fs";

import Fastify from "fastify";
import cors from "@fastify/cors";

import { ENV_FILE } from "./config.js";
import { cfg } from "./config.js";
import { getLatestScan } from "./db/repository.js";
import { registerScanRoutes } from "./routes/scans.js";
import { registerGraphRoutes } from "./routes/graph.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerEvalRoutes } from "./routes/evals.js";
import { registerConnectionRoutes } from "./routes/connection.js";

export async function buildApp() {
  const app = Fastify({
    logger: { level: process.env["LOG_LEVEL"] ?? "info" },
    // SSE responses are written directly to the raw socket and can outlive the
    // default timeout on a slow scan.
    connectionTimeout: 0,
    requestTimeout: 0,

    /**
     * ARNs travel as a path parameter, and Fastify's default cap is 100
     * characters.
     *
     * That default is a routing-performance guard, not a security control, and
     * 100 is far too low for this API: `/api/resources/:arn` carries a
     * percent-encoded ARN, where every `:` costs three characters and every `/`
     * costs three more. A service-linked role -
     * `arn:aws:iam::123456789012:role/aws-service-role/elasticloadbalancing.amazonaws.com/AWSServiceRoleForElasticLoadBalancing`
     * - is 120 characters raw and 136 encoded, so clicking one returned
     * `FST_ERR_MAX_PARAM_LENGTH` with HTTP 414 and the detail panel showed
     * nothing. The remediation route has the same shape, so "How to fix" was
     * broken for precisely the admin roles it matters most for.
     *
     * The mock account never triggered it: its role names are short and have no
     * IAM path, so the longest fixture ARN encodes to 61 characters. Only a real
     * account, which is full of service-linked roles, crosses the line
     * (engineering log #37).
     *
     * 2048 is chosen against IAM's documented maxima rather than picked round: a
     * role path may be 512 characters and a role name 64, so the longest
     * legitimate IAM ARN is roughly 600 raw and under 1800 encoded. Anything
     * beyond that is not an ARN this system produced.
     */
    maxParamLength: 2048,
  });

  await app.register(cors, { origin: true });

  /**
   * Health, with enough detail to be useful.
   *
   * Reports each dependency separately so a failure says *which* one, and
   * whether the agent is configured at all - a missing API key is the most
   * common reason chat does not work, and it should not take a failed request
   * to discover that.
   */
  app.get("/api/health", async () => {
    const checks: Record<string, string> = {};

    try {
      const { pool } = await import("./db/postgres.js");
      await pool.query("SELECT 1");
      checks["postgres"] = "ok";
    } catch (err) {
      checks["postgres"] = err instanceof Error ? err.message : "error";
    }

    try {
      const { readQuery } = await import("./db/neo4j.js");
      await readQuery("RETURN 1 AS ok");
      checks["neo4j"] = "ok";
    } catch (err) {
      checks["neo4j"] = err instanceof Error ? err.message : "error";
    }

    /**
     * When the key is missing, say where we looked for it.
     *
     * "ANTHROPIC_API_KEY not set" is true and was actively misleading to a user
     * who was looking at the key in their `.env` at the time: the real fault was
     * that `.env` had not been read at all (engineering log #36). Naming the file
     * distinguishes "you have not set it" from "we could not find your file", and
     * the second is the one you cannot guess.
     */
    checks["agent"] =
      cfg.ANTHROPIC_API_KEY && cfg.ANTHROPIC_API_KEY !== "replace-me"
        ? `configured (${cfg.ANTHROPIC_MODEL})`
        : existsSync(ENV_FILE)
          ? `ANTHROPIC_API_KEY not set in ${ENV_FILE} - chat will fail. Restart the API after editing it; configuration is read once at startup.`
          : `ANTHROPIC_API_KEY not set, and no .env found at ${ENV_FILE} - chat will fail. Copy .env.example to .env, or pass the variable through the environment.`;

    const latest = await getLatestScan().catch(() => null);

    /**
     * `degraded` means something that should work does not — not that an optional
     * feature is switched off.
     *
     * The LLM key is documented as optional: the scan, the graph, the findings and
     * the whole tier-1 eval suite run without it. Folding it into the overall
     * status meant a fresh clone reported `degraded` with both databases healthy,
     * which reads as a fault on the first thing a new reader looks at, and
     * contradicts the README telling them the key is optional.
     *
     * `checks.agent` still says exactly what is missing and where it looked, so a
     * caller that needs chat can require it; what changed is that the *service*
     * only claims to be degraded when a dependency it cannot work without is
     * actually failing.
     */
    const required = ["postgres", "neo4j"] as const;
    return {
      status: required.every((key) => checks[key] === "ok") ? "ok" : "degraded",
      checks,
      awsMode: cfg.AWS_MODE,
      lastScan: latest ? { id: latest.id, at: latest.startedAt, status: latest.status } : null,
    };
  });

  registerScanRoutes(app);
  registerGraphRoutes(app);
  registerChatRoutes(app);
  registerEvalRoutes(app);
  registerConnectionRoutes(app);

  return app;
}
