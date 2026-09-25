/** Process configuration, read once and validated at startup. */

import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv({ path: new URL("../../../.env", import.meta.url).pathname, quiet: true });

const schema = z.object({
  DATABASE_URL: z.string().default("postgres://dave:dave@localhost:5432/dave"),
  NEO4J_URI: z.string().default("bolt://localhost:7687"),
  NEO4J_USER: z.string().default("neo4j"),
  NEO4J_PASSWORD: z.string().default("neo4jneo4j"),

  /**
   * `mock` points every AWS client at moto and uses static source credentials.
   * `real` drops the endpoint override and uses the standard credential chain.
   * Nothing else about the scanner changes between the two.
   */
  AWS_MODE: z.enum(["mock", "real"]).default("mock"),
  AWS_ENDPOINT_URL: z.string().default("http://localhost:5000"),
  AWS_TARGET_ROLE_ARN: z.string().default("arn:aws:iam::123456789012:role/DaveIoReadOnlyRole"),
  AWS_EXTERNAL_ID: z.string().default("local-dev-external-id-0000"),
  AWS_REGION: z.string().default("us-east-1"),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),

  /**
   * Regions to scan. Empty means "discover them", which on a real account
   * means every region enabled for the account.
   */
  AWS_SCAN_REGIONS: z.string().default("us-east-1,eu-west-1,ap-southeast-1"),

  /** Max concurrent (service, region) units in flight. */
  SCAN_CONCURRENCY: z.coerce.number().int().positive().default(6),

  /**
   * Testing hook: comma-separated `service:region` pairs that should fail.
   * Used to demonstrate partial-failure handling without breaking the mock.
   * Example: `rds:eu-west-1,lambda:ap-southeast-1`
   */
  SCAN_FAULT_INJECTION: z.string().default(""),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-5"),

  BACKEND_PORT: z.coerce.number().int().positive().default(3000),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid configuration:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const cfg = parsed.data;

export const isMock = cfg.AWS_MODE === "mock";

/** Regions configured for scanning, or `null` to discover them from AWS. */
export function configuredRegions(): string[] | null {
  const raw = cfg.AWS_SCAN_REGIONS.trim();
  if (!raw) return null;
  return raw
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
}

/** Parse the fault-injection hook into a lookup set. */
export function faultInjections(): ReadonlySet<string> {
  return new Set(
    cfg.SCAN_FAULT_INJECTION.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}
