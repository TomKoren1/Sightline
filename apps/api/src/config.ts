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
 * rest.
 */
export const ENV_FILE = fileURLToPath(new URL("../../../.env", import.meta.url));

loadDotenv({ path: ENV_FILE, quiet: true });

/**
 * Zod's `.default()` only fires on `undefined`, but a blanked-out `.env` line
 * arrives as `""` - so `AWS_REGION=` reached the SDK as "Region is missing".
 *
 * Deliberately not applied to AWS_SCAN_REGIONS or SCAN_FAULT_INJECTION, where
 * blank is meaningful ("every region", "no faults").
 */
const blankAsUnset = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), inner);

/**
 * A yes/no environment variable, with no coercion.
 *
 * **Not** `z.coerce.boolean()`. That applies JavaScript's `Boolean()`, under
 * which every non-empty string is true - so `SCANS_ENABLED=false` enables
 * scans. A kill switch that cannot be switched off is worse than no kill
 * switch: it fails silently, during an incident, in the direction nobody wants.
 *
 * Unrecognised values are **refused** rather than guessed at. Configuration
 * that means one thing and does another is the whole failure mode here, and a
 * startup error naming the variable costs an operator seconds; a switch that
 * quietly stayed on costs whatever the incident costs.
 */
const TRUE = new Set(["1", "true", "yes", "on"]);
const FALSE = new Set(["0", "false", "no", "off"]);

const flag = (fallback: boolean) =>
  blankAsUnset(
    z
      .union([z.boolean(), z.string()])
      .optional()
      .transform((value, ctx) => {
        if (value === undefined) return fallback;
        if (typeof value === "boolean") return value;
        const normalised = value.trim().toLowerCase();
        if (TRUE.has(normalised)) return true;
        if (FALSE.has(normalised)) return false;
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `"${value}" is not a yes or a no. Use one of ` +
            `${[...TRUE].join(", ")} or ${[...FALSE].join(", ")}.`,
        });
        return z.NEVER;
      }),
  );

/**
 * The external id the mock fixture accepts. Published, not secret: moto
 * accepts any AssumeRole, and pretending this is a credential would be
 * theatre. Named so the demo path has one definition rather than three
 * string literals that have to agree.
 */
export const MOCK_EXTERNAL_ID = "local-dev-external-id-0000";

const schema = z.object({
  DATABASE_URL: blankAsUnset(
    z.string().default("postgres://sightline:sightline@localhost:5432/sightline"),
  ),
  /**
   * The restricted role every tenant-scoped query uses.
   *
   * Separate from `DATABASE_URL`, which is the owner and in this project's own
   * compose file is a superuser - and superusers ignore row-level security
   * entirely, `FORCE ROW LEVEL SECURITY` included. So without this the policies
   * exist and filter nothing. Hosted mode refuses to start without it.
   */
  DATABASE_URL_APP: blankAsUnset(z.string().optional()),
  /**
   * Read only by `npm run db:app-role`, to set the password of the cross-tenant
   * role (0010). API and worker pods get that URL *as* their `DATABASE_URL`,
   * so the owner's credentials go only to the migrate Job.
   */
  DATABASE_URL_SYSTEM: blankAsUnset(z.string().optional()),

  /**
   * Whether this process applies migrations before it starts listening.
   *
   * On for a clone, where one process is the whole deployment and a migration
   * on boot is simply convenient. Off in hosted mode, where two replicas would
   * race to apply the same migration - and where a Job is the thing that runs
   * them. A process with this off refuses to start against a schema that is
   * behind, rather than serving requests against one.
   *
   * Defaulted below rather than here, because it depends on DEPLOYMENT_MODE.
   */
  MIGRATE_ON_BOOT: blankAsUnset(z.enum(["true", "false"]).optional()),

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
  AWS_EXTERNAL_ID: blankAsUnset(z.string().default(MOCK_EXTERNAL_ID)),
  AWS_REGION: blankAsUnset(z.string().default("us-east-1")),

  /**
   * Who triggered this scan, for `sts:SourceIdentity` - so the customer's
   * CloudTrail attributes activity to an operator, not just the shared role.
   * Sanitised in `sourceIdentity()` below.
   */
  SCAN_OPERATOR: blankAsUnset(z.string().default("system")),
  AWS_ACCESS_KEY_ID: blankAsUnset(z.string().optional()),
  AWS_SECRET_ACCESS_KEY: blankAsUnset(z.string().optional()),

  /**
   * A separate identity for the secrets key, allowed `kms:Encrypt` and
   * `kms:Decrypt` on `AWS_KMS_KEY_ID` and nothing else. The API needs KMS to
   * store and show a connection's ExternalId, but must not hold the scanner
   * identity that can assume every customer's role - so the API gets these and
   * only the worker gets `AWS_ACCESS_KEY_ID`. Unset, KMS uses the default chain.
   */
  KMS_ACCESS_KEY_ID: blankAsUnset(z.string().optional()),
  KMS_SECRET_ACCESS_KEY: blankAsUnset(z.string().optional()),

  /**
   * Test seams for the browser suite (`e2e/`): a KMS other than AWS's, and an
   * identity provider standing in for GitHub. Hosted mode refuses both unless
   * PUBLIC_BASE_URL is loopback, so a deployment anyone else can reach cannot
   * have either - see `hostedMode.ts`.
   */
  KMS_ENDPOINT_URL: blankAsUnset(z.string().optional()),
  E2E_IDENTITY_PROVIDER_URL: blankAsUnset(z.string().optional()),

  /**
   * Regions to scan. Empty means "discover them", which on a real account
   * means every region enabled for the account.
   */
  AWS_SCAN_REGIONS: z.string().default("us-east-1,eu-west-1,ap-southeast-1"),

  /** Max concurrent (service, region) units in flight. */
  SCAN_CONCURRENCY: blankAsUnset(z.coerce.number().int().positive().default(6)),

  /**
   * Where scans run.
   *
   * `embedded` runs the queue worker inside the API process, which is what a
   * self-hosted operator wants: one container, `npm run dev` scans, nothing
   * else to start. `separate` means this process serves requests and runs no
   * worker, so a scan that exhausts memory or wedges on a slow account takes
   * down a worker rather than the API serving everybody else - and a hosted
   * deployment then has to actually run one, which `/api/health` reports on.
   * `off` is for a process that should never scan, such as a migration job.
   *
   * Defaulted below rather than here, because the right default depends on
   * DEPLOYMENT_MODE and a Zod default cannot see another field.
   */
  SCAN_WORKER: blankAsUnset(z.enum(["embedded", "separate", "off"]).optional()),

  /**
   * How many scans one worker runs at once.
   *
   * One, and the default is the point: a scan holds an account's whole
   * inventory in memory while it is analysed, so this multiplies the worker's
   * peak memory. Raising it is a statement about the
   * machine, which is why it is configuration rather than a constant.
   */
  SCAN_WORKER_CONCURRENCY: blankAsUnset(z.coerce.number().int().positive().default(1)),

  /**
   * Kill switches.
   *
   * Environment variables rather than a database row, which means flipping one
   * restarts the process. That is the right trade here: in Kubernetes an env
   * change is a rollout, which is how an operator turns a feature off anyway,
   * and a database-backed switch costs a read on the path of every request to
   * protect against an incident that happens approximately never. The cost is
   * that it is not instant - roughly a rollout - and the comment says so rather
   * than leaving somebody to discover it mid-incident.
   *
   * Scans stop at both ends when disabled: the API refuses to enqueue and the
   * worker refuses to claim, so the queue drains rather than building up.
   */
  SCANS_ENABLED: flag(true),
  CHAT_ENABLED: flag(true),

  /**
   * Minimum gap between finishing one scan of an account and starting the next.
   *
   * Defaulted below rather than here, because the right answer depends on whose
   * money is being spent: in a self-hosted clone it is the operator's own
   * account and their own AWS bill, and a cooldown would only get in their way.
   */
  SCAN_COOLDOWN_SECONDS: blankAsUnset(z.coerce.number().int().nonnegative().optional()),

  /** Scans one tenant may have queued or running across all their accounts. */
  MAX_ACTIVE_SCANS_PER_TENANT: blankAsUnset(z.coerce.number().int().positive().default(3)),

  /**
   * Resources one scan may produce before it is refused.
   *
   * Bounds the *graph*, not the scan's own peak memory: by the time this is
   * checked the collectors have already held every resource in an array, so an
   * account large enough to exhaust the worker exhausts it before this fires.
   * Fixing that needs streaming collection, which this is not. What it does buy
   * is a clear message instead of a graph too large to query or render, and
   * that is worth having on its own.
   */
  MAX_RESOURCES_PER_SCAN: blankAsUnset(z.coerce.number().int().positive().default(100_000)),

  /**
   * Finished scans kept per account; older ones are deleted with their
   * snapshots. Every scan holds a full copy of the estate, so without a limit
   * a daily scan of a large account grows the database without end. At least
   * two, so the latest scan always has one to be diffed against.
   */
  SCAN_HISTORY_KEEP: blankAsUnset(z.coerce.number().int().min(2).default(30)),

  /**
   * Questions one tenant may ask the agent per hour.
   *
   * Without this the Anthropic key is a free Claude proxy for anyone who signs
   * up. Defaulted below: self-hosted uses the operator's own key, so a quota
   * there limits nobody but them.
   */
  CHAT_QUESTIONS_PER_HOUR: blankAsUnset(z.coerce.number().int().positive().optional()),

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
   * Where Prometheus scrapes this process. `0` turns it off.
   *
   * Its own port, not a route on the one above: the worker serves no HTTP and
   * would otherwise be unobservable, and nginx proxies only the application
   * port, so metrics are unreachable from the internet by construction.
   */
  METRICS_PORT: blankAsUnset(z.coerce.number().int().min(0).default(9464)),
  /**
   * Bind address for the API. Loopback by default: the frontend reaches it
   * through Vite's server-side proxy, so it does not need to be exposed even
   * when the UI is served to another machine.
   */
  BACKEND_HOST: blankAsUnset(z.string().default("127.0.0.1")),

  /**
   * `self-hosted` is one operator, one account, no sign-in - the default, and
   * what a clone of this repository runs. `hosted` is the public service: many
   * tenants, sign-in required, and the capabilities that are harmless with one
   * operator but dangerous with many are removed rather than guarded. See
   * `hostedMode.ts`.
   */
  DEPLOYMENT_MODE: blankAsUnset(z.enum(["self-hosted", "hosted"]).default("self-hosted")),

  /** Where the service is reachable. Decides the OAuth redirect and the cookie's Secure flag. */
  PUBLIC_BASE_URL: blankAsUnset(z.string().default("http://localhost:5173")),

  /**
   * Tenant secrets at rest: KMS where there is one, else a local key. Hosted
   * mode requires KMS - a key in the environment is not an acceptable place to
   * hold half a credential for someone else's cloud.
   */
  AWS_KMS_KEY_ID: blankAsUnset(z.string().optional()),
  SECRETS_LOCAL_KEY: blankAsUnset(z.string().optional()),

  /**
   * The demo fixture's endpoint, for tenants who choose the demo account.
   *
   * Deliberately not `AWS_ENDPOINT_URL`, which is an SDK-wide override that
   * would redirect every signed call the process makes - including calls made
   * with credentials assumed inside a customer's account. This one names a
   * fixture the operator deployed and applies only to demo connections. Unset,
   * no demo connection can be created at all.
   */
  DEMO_AWS_ENDPOINT_URL: blankAsUnset(z.string().optional()),

  /**
   * The principal every customer's trust policy names: this service's own
   * identity. One value for the whole deployment, pre-filled into the
   * CloudFormation link a customer deploys.
   */
  SCANNER_PRINCIPAL_ARN: blankAsUnset(z.string().optional()),

  /** Where the read-only role template is published, for the one-click link. */
  ROLE_TEMPLATE_URL: blankAsUnset(z.string().optional()),

  GOOGLE_CLIENT_ID: blankAsUnset(z.string().optional()),
  GOOGLE_CLIENT_SECRET: blankAsUnset(z.string().optional()),
  GITHUB_CLIENT_ID: blankAsUnset(z.string().optional()),
  GITHUB_CLIENT_SECRET: blankAsUnset(z.string().optional()),

  /** Signing key for the OAuth `state` parameter and session cookies. */
  SESSION_SECRET: blankAsUnset(z.string().optional()),
  SESSION_TTL_HOURS: blankAsUnset(z.coerce.number().int().positive().default(8)),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid configuration:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const cfg = parsed.data;

/** The public multi-tenant service, as opposed to a single-operator clone. */
export const isHosted = (): boolean => cfg.DEPLOYMENT_MODE === "hosted";

/**
 * Whether this process should run the scan worker, and the default if unset.
 *
 * Hosted defaults to `separate`: a scan is the one thing in this system that
 * can consume an unbounded amount of memory, and in a multi-tenant deployment
 * it must not be able to take the API down with it. Self-hosted defaults to
 * `embedded`, because asking one operator to run a second container to scan
 * their own account is a worse tool with no benefit they can observe.
 *
 * A function rather than a constant so tests can set the variable and see the
 * effect without re-importing the module.
 */
export const scanWorkerMode = (): "embedded" | "separate" | "off" =>
  cfg.SCAN_WORKER ?? (isHosted() ? "separate" : "embedded");

/**
 * Limits whose sensible default depends on whose resources are being spent.
 *
 * A self-hosted clone scans the operator's own account with the operator's own
 * API key, so a cooldown and a chat quota there restrict nobody but them - and
 * a tool that rations its single user is just a worse tool. In a hosted
 * deployment the same numbers are what stand between one signup and an
 * unbounded AWS and Anthropic bill. Both are overridable; only the default
 * moves.
 */
export const scanCooldownSeconds = (): number =>
  cfg.SCAN_COOLDOWN_SECONDS ?? (isHosted() ? 300 : 0);

export const chatQuestionsPerHour = (): number | null =>
  cfg.CHAT_QUESTIONS_PER_HOUR ?? (isHosted() ? 60 : null);

/** Whether this process migrates on boot. See `MIGRATE_ON_BOOT`. */
export const migrateOnBoot = (): boolean =>
  cfg.MIGRATE_ON_BOOT ? cfg.MIGRATE_ON_BOOT === "true" : !isHosted();

/**
 * Should the session cookie be `Secure`?
 *
 * Follows the scheme rather than the mode. A Secure cookie over plain http is
 * dropped silently, which presents as "signing in does nothing" - and a
 * developer testing the hosted path over `http://<lan-ip>`, which unlike
 * `localhost` is not a secure context, would hit exactly that.
 */
export const useSecureCookies = (): boolean => cfg.PUBLIC_BASE_URL.startsWith("https://");

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

/**
 * Never true in hosted mode, whatever `AWS_MODE` says.
 *
 * The hosted invariants refuse `AWS_MODE=mock`, but they read the *raw*
 * environment - so an **unset** `AWS_MODE` passes them and then parses to the
 * `mock` default, leaving `isMock()` true on a public deployment. Found by
 * booting hosted mode and watching the legacy connection test aim its STS
 * calls at `http://localhost:5000`, which is the stale default
 * `AWS_ENDPOINT_URL` carries for the same reason.
 *
 * A mock path has no meaning in hosted mode - a demo account is a property of a
 * connection there - so the honest answer is no, and this is the one place that
 * can give it once for every caller.
 */
export const isMock = (): boolean => !isHosted() && activeMode === "mock";
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
 * getting this wrong writes a mock inventory under a real account id.
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
     * appear to do nothing.
     *
     * But the test is the **account id**, not the mode flag. `AWS_MODE=mock`
     * against a `.env` naming a real account used to honour the real ARN while
     * the endpoint override sent every call to moto, persisting 100 mock
     * resources under a real twelve-digit account id.
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
      externalId: MOCK_EXTERNAL_ID,
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
 * For a demo connection these are the static placeholders moto accepts. For a
 * real account they are only honoured if they look like genuine AWS keys, so a
 * placeholder left in `.env` cannot shadow the platform identity.
 *
 * Takes the connection's kind as an argument rather than reading a process-wide
 * mode: one process serves demo and real connections at the same time.
 */
export function sourceCredentials(
  isDemo: boolean,
): { accessKeyId: string; secretAccessKey: string } | undefined {
  if (isDemo) {
    return cfg.AWS_ACCESS_KEY_ID && cfg.AWS_SECRET_ACCESS_KEY
      ? { accessKeyId: cfg.AWS_ACCESS_KEY_ID, secretAccessKey: cfg.AWS_SECRET_ACCESS_KEY }
      : { accessKeyId: "mock", secretAccessKey: "mock" };
  }
  return looksLikeRealAccessKey(cfg.AWS_ACCESS_KEY_ID) && cfg.AWS_SECRET_ACCESS_KEY
    ? { accessKeyId: cfg.AWS_ACCESS_KEY_ID!, secretAccessKey: cfg.AWS_SECRET_ACCESS_KEY }
    : undefined;
}

/**
 * The home directory of the user the container runs as, which is where the AWS
 * SDK resolves `~` from. `deploy/compose.aws-profile.yml` must mount the host
 * profile here; `infra/composeAwsProfile.test.ts` ties the two together.
 */
export const CONTAINER_HOME = "/home/node";

/**
 * Where the AWS credential chain looks for a shared profile.
 *
 * Exported so the diagnosis below can be tested against a directory that exists
 * and is empty, which is the Windows failure mode and cannot be reproduced by
 * whatever happens to be on the machine running the tests.
 */
export function awsProfileDir(home = process.env["HOME"] ?? CONTAINER_HOME): string {
  return `${home}/.aws`;
}

/**
 * A stale mount at `/root/.aws` - where this project mounted the profile until
 * the api image stopped running as root - is deliberately **not** detected.
 *
 * It cannot be: `/root` is 0700, so traversing it fails with EACCES whether or
 * not anything is mounted inside, and `existsSync` returns false either way.
 * The diagnosis names the path it does read instead, which is what makes the
 * mismatch visible.
 */

/**
 * `CredentialsProviderError` says nothing about which link in the chain is
 * missing. In a container the two answers need opposite fixes: no keys in the
 * environment, or no `~/.aws` mount. Reports presence and shape only,
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
  /** The path the SDK reads, so the diagnosis can name it rather than say "~". */
  profileDir: string;
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
    profileDir: dir,
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
 * sending a SourceIdentity at all.
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
 * and ignores an edited `.env`.
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
