/** Process configuration, read once and validated at startup. */

import { fileURLToPath } from "node:url";

import { config as loadDotenv } from "dotenv";
import { existsSync, readdirSync } from "node:fs";
import { z } from "zod";

import { validateAssumeRoleTarget } from "./aws/principal.js";

/**
 * `fileURLToPath`, never `URL.pathname`: the latter is a URL path, so a drive
 * letter or a space in the directory gives `fs` something it cannot open.
 * `dotenv` then failed silently and no `.env` value loaded at all - only
 * `ANTHROPIC_API_KEY` broke visibly, since the Zod defaults below cover the
 * rest (engineering log #36).
 */
export const ENV_FILE = fileURLToPath(new URL("../../../.env", import.meta.url));

loadDotenv({ path: ENV_FILE, quiet: true });

/**
 * Zod's `.default()` only fires on `undefined`, but a blanked-out `.env` line
 * arrives as `""` - so `AWS_REGION=` reached the SDK as "Region is missing".
 *
 * Deliberately not applied to AWS_SCAN_REGIONS or SCAN_FAULT_INJECTION, where
 * blank is meaningful ("every region", "no faults") - engineering log #28.
 */
const blankAsUnset = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), inner);

const schema = z.object({
  DATABASE_URL: blankAsUnset(
    z.string().default("postgres://sightline:sightline@localhost:5432/sightline"),
  ),
  NEO4J_URI: blankAsUnset(z.string().default("bolt://localhost:7687")),
  NEO4J_USER: blankAsUnset(z.string().default("neo4j")),
  NEO4J_PASSWORD: blankAsUnset(z.string().default("neo4jneo4j")),

  /**
   * `mock` points every AWS client at moto and uses static source credentials.
   * `real` drops the endpoint override and uses the standard credential chain.
   * Nothing else about the scanner changes between the two.
   */
  AWS_MODE: blankAsUnset(z.enum(["mock", "real"]).default("mock")),
  AWS_ENDPOINT_URL: blankAsUnset(z.string().default("http://localhost:5000")),
  AWS_TARGET_ROLE_ARN: blankAsUnset(
    z.string().default("arn:aws:iam::123456789012:role/SightlineReadOnlyRole"),
  ),
  AWS_EXTERNAL_ID: blankAsUnset(z.string().default("local-dev-external-id-0000")),
  AWS_REGION: blankAsUnset(z.string().default("us-east-1")),

  /**
   * Who triggered this scan, for `sts:SourceIdentity` - so the customer's
   * CloudTrail attributes activity to an operator, not just the shared role.
   * Sanitised in `sourceIdentity()` below. ADR-007.
   */
  SCAN_OPERATOR: blankAsUnset(z.string().default("system")),
  AWS_ACCESS_KEY_ID: blankAsUnset(z.string().optional()),
  AWS_SECRET_ACCESS_KEY: blankAsUnset(z.string().optional()),

  /**
   * Regions to scan. Empty means "discover them", which on a real account
   * means every region enabled for the account.
   */
  AWS_SCAN_REGIONS: z.string().default("us-east-1,eu-west-1,ap-southeast-1"),

  /** Max concurrent (service, region) units in flight. */
  SCAN_CONCURRENCY: blankAsUnset(z.coerce.number().int().positive().default(6)),

  /**
   * Testing hook: comma-separated `service:region` pairs that should fail.
   * Used to demonstrate partial-failure handling without breaking the mock.
   * Example: `rds:eu-west-1,lambda:ap-southeast-1`
   */
  SCAN_FAULT_INJECTION: z.string().default(""),

  ANTHROPIC_API_KEY: blankAsUnset(z.string().optional()),
  ANTHROPIC_MODEL: blankAsUnset(z.string().default("claude-sonnet-5")),

  BACKEND_PORT: blankAsUnset(z.coerce.number().int().positive().default(3000)),
  /**
   * Bind address for the API. Loopback by default: the frontend reaches it
   * through Vite's server-side proxy, so it does not need to be exposed even
   * when the UI is served to another machine.
   */
  BACKEND_HOST: blankAsUnset(z.string().default("127.0.0.1")),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid configuration:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const cfg = parsed.data;

/**
 * The mode the process started in. `.env` decides this; the toggle does not
 * change it, so a restart always returns to a known state.
 */
export const configuredMode: "mock" | "real" = cfg.AWS_MODE;

/**
 * Switchable at runtime, so the UI moves between demo and real without a
 * restart. Readers call `isMock()` per call rather than capturing a boolean at
 * import, and clients are built per request, so a switch is immediate.
 */
let activeMode: "mock" | "real" = cfg.AWS_MODE;

export const isMock = (): boolean => activeMode === "mock";
export const currentMode = (): "mock" | "real" => activeMode;

export function setMode(mode: "mock" | "real"): void {
  activeMode = mode;
}

/**
 * The account id in an ARN, or null. Deliberately local: `aws/credentials.ts`
 * has the same helper but imports this module, so using it here would be a
 * cycle.
 */
export function accountOfArn(arn: string): string | null {
  const account = arn.split(":")[4];
  return account && /^\d{12}$/.test(account) ? account : null;
}

/**
 * Should mock mode use the role ARN from `.env`, or the mock's own? Pure and
 * exported because the module around it reads the environment at import, and
 * getting this wrong writes a mock inventory under a real account id (log #31).
 */
export function honoursConfiguredArnInMock(
  mode: "mock" | "real",
  targetRoleArn: string,
  mockAccountId: string,
): boolean {
  // `.env` describing a real account is not authority over the mock, whatever
  // AWS_MODE was overridden to on the command line.
  return mode === "mock" && accountOfArn(targetRoleArn) === mockAccountId;
}

/**
 * The mock's ARN and external id are derived, not read from `.env` - which
 * leaves `.env` free to hold the real account's settings permanently and makes
 * the toggle lossless both ways.
 */
export function activeConnection(): {
  roleArn: string;
  externalId: string;
  endpoint: string | null;
} {
  if (activeMode === "mock") {
    const account = process.env["MOCK_AWS_ACCOUNT_ID"] ?? "123456789012";

    /**
     * The onboarding variables win when `.env` really describes the mock -
     * ignoring them because a runtime toggle exists would make editing them
     * appear to do nothing (log #24).
     *
     * But the test is the **account id**, not the mode flag. `AWS_MODE=mock`
     * against a `.env` naming a real account used to honour the real ARN while
     * the endpoint override sent every call to moto, persisting 100 mock
     * resources under a real twelve-digit account id (log #31).
     */
    if (honoursConfiguredArnInMock(configuredMode, cfg.AWS_TARGET_ROLE_ARN, account)) {
      return {
        roleArn: cfg.AWS_TARGET_ROLE_ARN,
        externalId: cfg.AWS_EXTERNAL_ID,
        endpoint: cfg.AWS_ENDPOINT_URL,
      };
    }

    if (configuredMode === "mock") {
      console.warn(
        `\n  AWS_TARGET_ROLE_ARN names account ${accountOfArn(cfg.AWS_TARGET_ROLE_ARN) ?? "?"}, but this is mock mode\n` +
          `  and the mock account is ${account}. Using the mock's own role so the scan cannot be\n` +
          "  recorded under a real account id. Set MOCK_AWS_ACCOUNT_ID to match, or AWS_MODE=real.\n",
      );
    }

    return {
      roleArn: `arn:aws:iam::${account}:role/SightlineReadOnlyRole`,
      externalId: "local-dev-external-id-0000",
      endpoint: cfg.AWS_ENDPOINT_URL,
    };
  }
  return { roleArn: cfg.AWS_TARGET_ROLE_ARN, externalId: cfg.AWS_EXTERNAL_ID, endpoint: null };
}

/**
 * `sts:AssumeRole` can only assume a role, and a user ARN here is the likeliest
 * misconfiguration - it is the right answer to the question the guide asks two
 * steps earlier, and the two variables sit next to each other.
 *
 * Reported, not fatal: the UI is where the guide explaining the fix lives, so a
 * process that dies on bad configuration cannot tell you how to correct it.
 */
export function targetRoleProblem(): string | null {
  // The mock's derived ARN is always well-formed, so there is nothing to warn
  // about until the configuration is actually pointed at AWS.
  if (activeMode === "mock" && configuredMode === "mock") return null;
  const result = validateAssumeRoleTarget(cfg.AWS_TARGET_ROLE_ARN);
  return result.ok ? null : result.reason;
}

{
  const problem = targetRoleProblem();
  if (problem) console.warn(`\n  AWS_TARGET_ROLE_ARN cannot be assumed.\n  ${problem}\n`);
}

/**
 * Does this look like a genuine AWS access key id?
 *
 * Real ones carry a documented prefix and a fixed shape. The placeholder value
 * shipped in `.env.example` for talking to the mock does not.
 */
/**
 * The placeholder `.env.example` ships, so "you have not replaced it yet" can be
 * distinguished from "your value is wrong". Those need different actions and the
 * old message covered both with one sentence.
 */
export const MOCK_ACCESS_KEY_PLACEHOLDER = "mock";

export function looksLikeRealAccessKey(value: string | undefined): boolean {
  return Boolean(value && /^(AKIA|ASIA|ABIA|ACCA|A3T)[A-Z0-9]{12,}$/.test(value));
}

/**
 * Stop the mock's placeholder credentials from shadowing real ones.
 *
 * `AWS_ACCESS_KEY_ID=mock` in `process.env` is visible to the SDK's environment
 * provider - first in its chain - so in real mode it wins over
 * `~/.aws/credentials` and every call fails `InvalidClientTokenId`. Deleting is
 * the only fix, since the SDK reads `process.env` directly. Key-shaped values
 * are left alone.
 */
/**
 * SDK-read variables `.env` must not set once we are talking to a real account.
 *
 * `AWS_ENDPOINT_URL` is the dangerous one: left over from the mock it redirects
 * every client, STS included, away from AWS. The scan then enumerates the mock
 * and labels it with the real account id, and the connection test passes
 * because moto accepts any AssumeRole - a fabricated inventory of a real
 * account.
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

{
  const leaked = SDK_ENV_OVERRIDES.filter((key) => process.env[key]);
  if (leaked.length > 0) {
    console.warn(
      `\n  ${leaked.join(", ")} is set in the environment.\n` +
        "  The AWS SDK reads these directly, so they would override the endpoint for\n" +
        "  every request - including sts:AssumeRole - regardless of AWS_MODE. They are\n" +
        "  being removed; the mock endpoint is passed explicitly instead.\n",
    );
    for (const key of leaked) delete process.env[key];
  }

  const hasPlaceholder =
    (cfg.AWS_ACCESS_KEY_ID && !looksLikeRealAccessKey(cfg.AWS_ACCESS_KEY_ID)) ?? false;

  if (hasPlaceholder) {
    console.warn(
      `  AWS_ACCESS_KEY_ID="${cfg.AWS_ACCESS_KEY_ID}" is not a real AWS key. It is the\n` +
        "  placeholder used for the mock, and being first in the SDK's credential chain it\n" +
        "  would shadow real credentials, so it is being removed from the environment. The\n" +
        "  mock's credentials are passed explicitly instead.\n",
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
  if (isMock()) {
    return cfg.AWS_ACCESS_KEY_ID && cfg.AWS_SECRET_ACCESS_KEY
      ? { accessKeyId: cfg.AWS_ACCESS_KEY_ID, secretAccessKey: cfg.AWS_SECRET_ACCESS_KEY }
      : { accessKeyId: "mock", secretAccessKey: "mock" };
  }
  return looksLikeRealAccessKey(cfg.AWS_ACCESS_KEY_ID) && cfg.AWS_SECRET_ACCESS_KEY
    ? { accessKeyId: cfg.AWS_ACCESS_KEY_ID!, secretAccessKey: cfg.AWS_SECRET_ACCESS_KEY }
    : undefined;
}

/**
 * Where the AWS credential chain looks for a shared profile.
 *
 * Exported so the diagnosis below can be tested against a directory that exists
 * and is empty, which is the Windows failure mode and cannot be reproduced by
 * whatever happens to be on the machine running the tests.
 */
export function awsProfileDir(home = process.env["HOME"] ?? "/root"): string {
  return `${home}/.aws`;
}

/**
 * `CredentialsProviderError` says nothing about which link in the chain is
 * missing. In a container the two answers need opposite fixes: no keys in the
 * environment, or no `~/.aws` mount (log #48). Reports presence and shape only,
 * never a value.
 */
export function credentialSources(): {
  containerised: boolean;
  envKeySet: boolean;
  envKeyLooksReal: boolean;
  /** The value is still the placeholder `.env.example` ships for the mock. */
  envKeyIsMockPlaceholder: boolean;
  /**
   * Length only, so a truncated or half-pasted key is visible without printing
   * one. An access key id is an identifier rather than a secret, and even so
   * there is no reason to echo it.
   */
  envKeyLength: number;
  /** The directory exists, whether or not it holds anything. */
  profileDirExists: boolean;
  profileFiles: string[];
} {
  const dir = awsProfileDir();
  let profileFiles: string[] = [];
  try {
    profileFiles = readdirSync(dir);
  } catch {
    // Absent or unreadable; both mean the chain cannot use it.
  }
  return {
    containerised: inContainer(),
    envKeySet: Boolean(cfg.AWS_ACCESS_KEY_ID),
    envKeyLooksReal: looksLikeRealAccessKey(cfg.AWS_ACCESS_KEY_ID),
    envKeyIsMockPlaceholder: cfg.AWS_ACCESS_KEY_ID === MOCK_ACCESS_KEY_PLACEHOLDER,
    envKeyLength: cfg.AWS_ACCESS_KEY_ID?.length ?? 0,
    /**
     * Existence is reported separately from contents, because the two point at
     * different fixes. An empty directory means the mount landed on the wrong
     * path - the Windows case, where an unset HOME resolves the source to
     * `/.aws` - while an absent one means no mount was configured at all.
     */
    profileDirExists: existsSync(dir),
    profileFiles,
  };
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

/**
 * Hyphen, not colon: AWS restricts `SourceIdentity` to alphanumerics,
 * underscore and `+=,.@-`. The trust policy originally matched `sightline:*`,
 * which no legal value can satisfy, and nothing caught it because nothing was
 * sending a SourceIdentity at all (engineering log #42).
 */
export const SOURCE_IDENTITY_PREFIX = "sightline-";

/** Characters AWS permits in SourceIdentity, per the AssumeRole API reference. */
const SOURCE_IDENTITY_ALLOWED = /[^A-Za-z0-9_+=,.@-]/g;

/**
 * Sanitised rather than rejected: an operator name with a space should not fail
 * every scan. Truncated to AWS's 64 characters and never empty, since the trust
 * policy requires the key present. Pure, so it is testable without reloading
 * this module.
 */
export function toSourceIdentity(operator: string): string {
  const cleaned = operator.replace(SOURCE_IDENTITY_ALLOWED, "-").replace(/^-+|-+$/g, "");
  return `${SOURCE_IDENTITY_PREFIX}${cleaned || "system"}`.slice(0, 64);
}

/**
 * So the onboarding guide shows one restart command rather than both and a rule
 * for choosing. The two differ: in a container the API must be *recreated*,
 * because `docker compose restart` reuses the environment resolved at creation
 * and ignores an edited `.env` (log #44).
 *
 * `/.dockerenv` is a heuristic, so it only picks which instructions to show -
 * never anything about AWS.
 */
export function inContainer(): boolean {
  return existsSync("/.dockerenv");
}

/** The value sent as `sts:SourceIdentity` on every AssumeRole. */
export function sourceIdentity(): string {
  return toSourceIdentity(cfg.SCAN_OPERATOR);
}
