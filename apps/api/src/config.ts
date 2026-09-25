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
  /**
   * Bind address for the API. Loopback by default: the frontend reaches it
   * through Vite's server-side proxy, so it does not need to be exposed even
   * when the UI is served to another machine.
   */
  BACKEND_HOST: z.string().default("127.0.0.1"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid configuration:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const cfg = parsed.data;

export const isMock = cfg.AWS_MODE === "mock";

/**
 * Does this look like a genuine AWS access key id?
 *
 * Real ones carry a documented prefix and a fixed shape. The placeholder value
 * shipped in `.env.example` for talking to the mock does not.
 */
function looksLikeRealAccessKey(value: string | undefined): boolean {
  return Boolean(value && /^(AKIA|ASIA|ABIA|ACCA|A3T)[A-Z0-9]{12,}$/.test(value));
}

/**
 * Stop the mock's placeholder credentials from shadowing real ones.
 *
 * `.env` is loaded into `process.env`, which means `AWS_ACCESS_KEY_ID=mock` is
 * visible to the AWS SDK's own environment credential provider - the first
 * provider in its chain. So in `real` mode a leftover placeholder does not
 * merely get ignored, it actively wins over `~/.aws/credentials`, an instance
 * role, or anything else, and every call fails with `InvalidClientTokenId`.
 *
 * Deleting the variables is the only fix that works, because the SDK reads
 * `process.env` directly rather than anything we control. Values that look like
 * genuine AWS keys are left alone: supplying real credentials this way is
 * legitimate.
 */
/**
 * Variables the AWS SDK reads directly from the environment, which `.env` must
 * not be allowed to set once we are talking to a real account.
 *
 * `AWS_ENDPOINT_URL` is the dangerous one. It is a documented SDK-wide endpoint
 * override, so a value left in `.env` for the mock silently redirects **every**
 * client - STS included - away from AWS. The scanner then enumerates the mock
 * and labels the results with the real account id taken from the role ARN, and
 * the connection test passes, because moto accepts any AssumeRole it is given.
 *
 * The result is a confident, plausible, entirely fabricated inventory of
 * somebody's AWS account. That is the exact failure this project exists to
 * prevent elsewhere, so it is worth being blunt about here.
 */
const SDK_ENV_OVERRIDES = [
  "AWS_ENDPOINT_URL",
  "AWS_ENDPOINT_URL_STS",
  "AWS_ENDPOINT_URL_EC2",
  "AWS_ENDPOINT_URL_S3",
  "AWS_ENDPOINT_URL_IAM",
  "AWS_ENDPOINT_URL_RDS",
  "AWS_ENDPOINT_URL_LAMBDA",
  "AWS_USE_DUALSTACK_ENDPOINT",
  "AWS_USE_FIPS_ENDPOINT",
];

if (!isMock) {
  const leaked = SDK_ENV_OVERRIDES.filter((key) => process.env[key]);
  if (leaked.length > 0) {
    console.warn(
      `\n  AWS_MODE=real, but ${leaked.join(", ")} is set in the environment.\n` +
        "  The AWS SDK reads these directly and would send every request - including\n" +
        "  sts:AssumeRole - to that endpoint instead of to AWS, producing an inventory\n" +
        "  of the mock labelled with your real account id. They are being removed.\n" +
        "  Set AWS_MODE=mock to use the mock deliberately.\n",
    );
    for (const key of leaked) delete process.env[key];
  }

  const hasPlaceholder =
    (cfg.AWS_ACCESS_KEY_ID && !looksLikeRealAccessKey(cfg.AWS_ACCESS_KEY_ID)) ?? false;

  if (hasPlaceholder) {
    console.warn(
      `\n  AWS_MODE=real, but AWS_ACCESS_KEY_ID="${cfg.AWS_ACCESS_KEY_ID}" is not a real AWS key.\n` +
        "  It is the placeholder used for the mock, and it would shadow your real credentials,\n" +
        "  so it is being ignored. Remove AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY from .env\n" +
        "  to silence this - the standard AWS credential chain will be used instead.\n",
    );
    delete process.env["AWS_ACCESS_KEY_ID"];
    delete process.env["AWS_SECRET_ACCESS_KEY"];
    delete process.env["AWS_SESSION_TOKEN"];
  }
}

/**
 * Source credentials to call `sts:AssumeRole` with, or `undefined` to use the
 * standard AWS credential chain.
 *
 * In `mock` mode these are the static placeholders moto accepts. In `real` mode
 * they are only honoured if they look like genuine AWS keys.
 */
export function sourceCredentials(): { accessKeyId: string; secretAccessKey: string } | undefined {
  if (isMock) {
    return cfg.AWS_ACCESS_KEY_ID && cfg.AWS_SECRET_ACCESS_KEY
      ? { accessKeyId: cfg.AWS_ACCESS_KEY_ID, secretAccessKey: cfg.AWS_SECRET_ACCESS_KEY }
      : { accessKeyId: "mock", secretAccessKey: "mock" };
  }
  return looksLikeRealAccessKey(cfg.AWS_ACCESS_KEY_ID) && cfg.AWS_SECRET_ACCESS_KEY
    ? { accessKeyId: cfg.AWS_ACCESS_KEY_ID!, secretAccessKey: cfg.AWS_SECRET_ACCESS_KEY }
    : undefined;
}

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
