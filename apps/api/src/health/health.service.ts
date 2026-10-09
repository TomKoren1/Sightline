/**
 * Health, with enough detail to be useful.
 *
 * Reports each dependency separately so a failure says *which* one, and whether
 * the agent is configured at all - a missing API key is the most common reason
 * chat does not work, and it should not take a failed request to discover that.
 */

import { existsSync } from "node:fs";
import { Injectable } from "@nestjs/common";

import { cfg, ENV_FILE } from "../config.js";
import { readQuery } from "../db/neo4j.js";
import { pool } from "../db/postgres.js";
import { getLatestScan } from "../db/repository.js";

/**
 * Dependencies the service cannot work without.
 *
 * The LLM key is deliberately not among them - see `overallStatus`.
 */
const REQUIRED = ["postgres", "neo4j"] as const;

export interface HealthReport {
  status: "ok" | "degraded";
  checks: Record<string, string>;
  awsMode: string;
  lastScan: { id: string; at: string; status: string } | null;
}

@Injectable()
export class HealthService {
  async report(): Promise<HealthReport> {
    const checks: Record<string, string> = {};

    try {
      // A bare liveness probe rather than a question about the domain, which
      // is why it is the one query in this package that does not go through
      // the ORM.
      await pool.query("SELECT 1");
      checks["postgres"] = "ok";
    } catch (err) {
      checks["postgres"] = err instanceof Error ? err.message : "error";
    }

    try {
      await readQuery("RETURN 1 AS ok");
      checks["neo4j"] = "ok";
    } catch (err) {
      checks["neo4j"] = err instanceof Error ? err.message : "error";
    }

    checks["agent"] = this.agentCheck();

    const latest = await getLatestScan().catch(() => null);

    return {
      status: REQUIRED.every((key) => checks[key] === "ok") ? "ok" : "degraded",
      checks,
      awsMode: cfg.AWS_MODE,
      lastScan: latest ? { id: latest.id, at: latest.startedAt, status: latest.status } : null,
    };
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
  private agentCheck(): string {
    if (cfg.ANTHROPIC_API_KEY && cfg.ANTHROPIC_API_KEY !== "replace-me") {
      return `configured (${cfg.ANTHROPIC_MODEL})`;
    }
    return existsSync(ENV_FILE)
      ? `ANTHROPIC_API_KEY not set in ${ENV_FILE} - chat will fail. Restart the API after editing it; configuration is read once at startup.`
      : `ANTHROPIC_API_KEY not set, and no .env found at ${ENV_FILE} - chat will fail. Copy .env.example to .env, or pass the variable through the environment.`;
  }
}
