/** HTTP server. */

import Fastify from "fastify";
import cors from "@fastify/cors";

import { cfg } from "./config.js";
import { migrate, closePool } from "./db/postgres.js";
import { closeDriver } from "./db/neo4j.js";
import { getLatestScan } from "./db/repository.js";
import { registerScanRoutes } from "./routes/scans.js";
import { registerGraphRoutes } from "./routes/graph.js";
import { registerChatRoutes } from "./routes/chat.js";

const app = Fastify({
  logger: { level: process.env["LOG_LEVEL"] ?? "info" },
  // SSE responses are written directly to the raw socket and can outlive the
  // default timeout on a slow scan.
  connectionTimeout: 0,
  requestTimeout: 0,
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

  checks["agent"] =
    cfg.ANTHROPIC_API_KEY && cfg.ANTHROPIC_API_KEY !== "replace-me"
      ? `configured (${cfg.ANTHROPIC_MODEL})`
      : "ANTHROPIC_API_KEY not set - chat will fail";

  const latest = await getLatestScan().catch(() => null);

  return {
    status: Object.values(checks).every((v) => v === "ok" || v.startsWith("configured"))
      ? "ok"
      : "degraded",
    checks,
    awsMode: cfg.AWS_MODE,
    lastScan: latest ? { id: latest.id, at: latest.startedAt, status: latest.status } : null,
  };
});

registerScanRoutes(app);
registerGraphRoutes(app);
registerChatRoutes(app);

try {
  await migrate();
  await app.listen({ port: cfg.BACKEND_PORT, host: "0.0.0.0" });
  app.log.info(`AWS mode: ${cfg.AWS_MODE}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    app.log.info(`${signal} received, shutting down`);
    await app.close();
    await closeDriver();
    await closePool();
    process.exit(0);
  });
}
