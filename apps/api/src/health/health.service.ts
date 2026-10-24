/**
 * Health, with enough detail to be useful.
 *
 * Reports each dependency separately so a failure says *which* one, and whether
 * the agent is configured at all - a missing API key is the most common reason
 * chat does not work, and it should not take a failed request to discover that.
 */

import { existsSync } from "node:fs";
import { Injectable } from "@nestjs/common";

import { cfg, ENV_FILE, isHosted } from "../core/config.js";
import { pool } from "../db/postgres.js";
import { getLatestScan } from "../db/repository.js";
import { localScope } from "../tenancy/local.js";

/**
 * Dependencies the service cannot work without.
 *
 * The LLM key is deliberately not among them - see `overallStatus`.
 */
const REQUIRED = ["postgres"] as const;

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

    checks["agent"] = this.agentCheck();

    /**
     * The last scan, in self-hosted only.
     *
     * This route is public - the cluster scrapes it and Prometheus cannot be
     * given a session - so in hosted mode it must carry no tenant's data. A
     * single-operator deployment has exactly one tenant and uses this as a
     * dashboard, which is why it is not simply dropped.
     */
    const latest = isHosted() ? null : await getLatestScan(localScope()).catch(() => null);

    return {
      status: REQUIRED.every((key) => checks[key] === "ok") ? "ok" : "degraded",
      checks,
      /**
       * The process-wide mode, which exists only in a self-hosted deployment.
       * Reporting `mock` on a public one - which it would, from the Zod
       * default - says something untrue about where the scanner is pointed.
       */
      awsMode: isHosted() ? "per-connection" : cfg.AWS_MODE,
      lastScan: latest ? { id: latest.id, at: latest.startedAt, status: latest.status } : null,
    };
  }

  /**
   * When the key is missing, say where we looked for it.
   *
   * "ANTHROPIC_API_KEY not set" is true and was actively misleading to a user
   * who was looking at the key in their `.env` at the time: the real fault was
   * that `.env` had not been read at all. Naming the file
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
