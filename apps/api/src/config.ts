/** Process configuration, read once and validated at startup. */

import { fileURLToPath } from "node:url";

import { config as loadDotenv } from "dotenv";
import { existsSync, readdirSync } from "node:fs";
import { z } from "zod";

import { validateAssumeRoleTarget } from "./aws/principal.js";

/**
 * Where `.env` lives, as a **filesystem** path.
 *
 * `new URL(...).pathname` is a URL path, not a filesystem path, and the two
 * differ whenever the real path needs escaping. On Windows it yields
 * `/C:/projects/app/.env` - a leading slash before the drive letter, which
 * `fs` cannot open. On any OS, a directory containing a space yields
 * `/home/me/My%20Projects/.env`, which `fs` also cannot open.
 *
 * Either way `dotenv` failed with ENOENT, and because it was called with
 * `quiet: true` it failed **silently** - so no variable from `.env` was ever
 * loaded. The Zod defaults below happen to match `.env.example`, so Postgres,
 * Neo4j and the mock kept working and only `ANTHROPIC_API_KEY`, which has no
 * default, visibly broke. A Windows user got "ANTHROPIC_API_KEY not set" while
 * looking at the key in their `.env`, and any other value they had edited was
 * being ignored too (engineering log #36).
 *
 * `fileURLToPath` is the documented conversion and is correct on every
 * platform. `URL.pathname` should never be used to address the filesystem.
 */
export const ENV_FILE = fileURLToPath(new URL("../../../.env", import.meta.url));

loadDotenv({ path: ENV_FILE, quiet: true });

/**
 * Treat an empty value as an unset one.
 *
 * `.env` is a text file, so a variable someone has blanked out arrives as `""`
 * rather than as `undefined` - and Zod's `.default()` only fires on
 * `undefined`. `AWS_REGION=` therefore produced `cfg.AWS_REGION === ""`, which
 * the AWS SDK rejects with "Region is missing" from whichever client happened
 * to be constructed first. The variable looked present and documented; it was
 * simply empty, and the default that was supposed to cover it never ran.
 *
 * Applied to every variable where a blank value means nothing. It is
 * deliberately **not** applied to AWS_SCAN_REGIONS or SCAN_FAULT_INJECTION,
 * where blank is a documented, meaningful value - "discover every region" and
 * "inject no faults" respectively - and collapsing it into the default would
 * silently change behaviour. See engineering log #28.
 */
const blankAsUnset = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), inner);

const schema = z.object({
  DATABASE_URL: blankAsUnset(z.string().default("postgres://dave:dave@localhost:5432/dave")),
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
    z.string().default("arn:aws:iam::123456789012:role/DaveIoReadOnlyRole"),
  ),
  AWS_EXTERNAL_ID: blankAsUnset(z.string().default("local-dev-external-id-0000")),
  AWS_REGION: blankAsUnset(z.string().default("us-east-1")),

  /**
   * Who or what triggered this scan, for `sts:SourceIdentity`.
   *
   * Sent on every AssumeRole so the *customer's* CloudTrail attributes activity
   * to an operator or system rather than only to the shared scanner role, and
   * cannot be changed for the life of the session. See ADR-007 and the trust
   * policy in `infra/readonly-role.yaml`.
   *
   * Prefixed and sanitised in `sourceIdentity()` below rather than here, so an
   * operator name that AWS would reject cannot reach the API call.
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
 * The mode currently in effect.
 *
 * Switchable at runtime so the UI can move between the seeded demo account and
 * a real one without a restart. Everything that depends on it reads
 * `isMock()` per call rather than capturing a boolean at import, and the AWS
 * clients are constructed per request, so a switch takes effect immediately -
 * after the cached STS session is dropped, which `setMode` handles.
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
 * Should mock mode use the role ARN from `.env`, or the mock's own?
 *
 * Exported as a pure function because the answer is load-bearing and the module
 * around it reads the environment at import time, which makes it untestable in
 * place. Getting this wrong writes a mock inventory to Postgres under a real
 * account id - see `activeConnection` and engineering log #31.
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
 * Connection settings for the mode in effect.
 *
 * The mock's role ARN and external id are fixed by the seeder, so they are
 * derived rather than read from `.env` - which leaves `.env` free to hold the
 * real account's settings permanently, and makes the toggle lossless in both
 * directions.
 */
export function activeConnection(): {
  roleArn: string;
  externalId: string;
  endpoint: string | null;
} {
  if (activeMode === "mock") {
    const account = process.env["MOCK_AWS_ACCOUNT_ID"] ?? "123456789012";

    /**
     * When `.env` really does describe the mock, its values are authoritative.
     *
     * `AWS_TARGET_ROLE_ARN` and `AWS_EXTERNAL_ID` are the onboarding variables
     * the project ships with, and silently ignoring them because a runtime
     * toggle exists would be a nasty surprise: editing them would appear to do
     * nothing (engineering log #24). So they win - but the test for "describes
     * the mock" is the **account id**, not the mode flag.
     *
     * That distinction is the whole fix. `AWS_MODE=mock npm run
     * scan` against a `.env` that points at a real account makes
     * `configuredMode` "mock" while `AWS_TARGET_ROLE_ARN` still names the real
     * account - so this branch honoured a real role ARN while the endpoint
     * override sent every call to moto. The scan read the mock's inventory and
     * wrote it to Postgres under the *real* account id.
     *
     * That is engineering log #17 arriving through a different door: a
     * confident, complete, entirely fictional inventory of somebody's real AWS
     * account. Observed, not theorised - 100 mock resources persisted under a
     * real twelve-digit account (engineering log #31).
     *
     * So the onboarding variables are honoured only when their account matches
     * the mock's. Anything else is configuration for a different account and is
     * ignored in favour of the mock's own identity, loudly.
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
      roleArn: `arn:aws:iam::${account}:role/DaveIoReadOnlyRole`,
      externalId: "local-dev-external-id-0000",
      endpoint: cfg.AWS_ENDPOINT_URL,
    };
  }
  return { roleArn: cfg.AWS_TARGET_ROLE_ARN, externalId: cfg.AWS_EXTERNAL_ID, endpoint: null };
}

/**
 * Whether the configured target role can possibly work, and if not, why.
 *
 * `sts:AssumeRole` can only assume a **role**. A user ARN here is the single
 * most likely misconfiguration, because it is the correct answer to a
 * different question the onboarding guide asks two steps earlier - the
 * principal the customer's trust policy should name. The two variables sit
 * next to each other and one is a valid-looking value for the other.
 *
 * Reported rather than fatal. Exiting would leave the UI unable to load, and
 * the UI is where the connection guide that explains the fix lives; a process
 * that dies on bad configuration cannot tell you how to correct it. So this
 * surfaces at startup, through `/api/connection`, and in the connection test.
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
 * What the AWS credential chain has to work with, for diagnosis.
 *
 * `CredentialsProviderError` means "nothing in the chain produced credentials",
 * which is accurate and tells a reader nothing about which link is missing. In a
 * container there are two plausible answers and they need opposite fixes: no keys
 * in the environment, or no `~/.aws` because the host's profile was never
 * mounted. Enumerating both turns one generic sentence into a specific one
 * (engineering log #48).
 *
 * Reports only presence and shape, never a value. A diagnosis that leaks half a
 * secret into a UI is not an improvement.
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
 * The prefix the role template's trust policy requires.
 *
 * Hyphen, not colon. AWS restricts `SourceIdentity` to alphanumerics,
 * underscore and `+=,.@-` - a colon is rejected outright. The trust policy
 * originally matched `daveio:*`, a pattern no legal value can satisfy, and
 * nothing caught it because no SourceIdentity was being sent at all. A
 * condition that can never match is indistinguishable from no condition until
 * the day you rely on it (engineering log #42).
 */
export const SOURCE_IDENTITY_PREFIX = "daveio-";

/** Characters AWS permits in SourceIdentity, per the AssumeRole API reference. */
const SOURCE_IDENTITY_ALLOWED = /[^A-Za-z0-9_+=,.@-]/g;

/**
 * Build a legal `sts:SourceIdentity` from an operator name.
 *
 * Sanitised rather than validated-and-rejected: an operator name with a space in
 * it should not be able to fail every scan. Truncated to AWS's 64-character
 * limit, and never empty, because the trust policy requires the key present.
 *
 * Pure, and exported separately from `sourceIdentity()` so the sanitising can be
 * tested across a range of inputs without reloading the config module - which is
 * frozen at import and cannot be re-read per test.
 */
export function toSourceIdentity(operator: string): string {
  const cleaned = operator.replace(SOURCE_IDENTITY_ALLOWED, "-").replace(/^-+|-+$/g, "");
  return `${SOURCE_IDENTITY_PREFIX}${cleaned || "system"}`.slice(0, 64);
}

/**
 * Whether this process is running inside a container.
 *
 * Used by the onboarding guide to show the restart command that applies here
 * rather than both and a rule for choosing. The two differ in a way that
 * matters: on a host the API is restarted, in a container it has to be
 * *recreated*, because `docker compose restart` reuses the environment resolved
 * when the container was created and so ignores an edited `.env` entirely
 * (engineering log #44).
 *
 * `/.dockerenv` is written by the Docker daemon into every container it starts.
 * It is a heuristic - a different runtime may not create it - so it is only ever
 * used to pick which instructions to show, never to decide anything about AWS.
 */
export function inContainer(): boolean {
  return existsSync("/.dockerenv");
}

/** The value sent as `sts:SourceIdentity` on every AssumeRole. */
export function sourceIdentity(): string {
  return toSourceIdentity(cfg.SCAN_OPERATOR);
}
