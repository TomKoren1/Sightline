/**
 * The AWS side of configuration: which mode the process is in, the role and
 * regions to scan, and which credentials to start from. Kept apart from
 * core/config.ts, which parses settings and depends on nothing else in src;
 * this module builds on it and on the credential code beside it.
 */

import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from "@aws-sdk/types";
import { existsSync, readdirSync } from "node:fs";

import {
  cfg,
  isHosted,
  looksLikeRealAccessKey,
  MOCK_ACCESS_KEY_PLACEHOLDER,
  MOCK_EXTERNAL_ID,
} from "../core/config.js";
import { validateAssumeRoleTarget } from "./principal.js";
import { rolesAnywhereProvider } from "./rolesAnywhere.js";

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
 * The hosted invariants refuse `AWS_MODE=mock`, but read the raw environment:
 * an unset `AWS_MODE` passes them and parses to the `mock` default, which once
 * aimed the legacy connection test's STS calls at `http://localhost:5000`. A
 * demo account is a property of a connection in hosted mode, so the answer
 * here is no, given once for every caller.
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
): AwsCredentialIdentity | AwsCredentialIdentityProvider | undefined {
  if (isDemo) {
    return cfg.AWS_ACCESS_KEY_ID && cfg.AWS_SECRET_ACCESS_KEY
      ? { accessKeyId: cfg.AWS_ACCESS_KEY_ID, secretAccessKey: cfg.AWS_SECRET_ACCESS_KEY }
      : { accessKeyId: "mock", secretAccessKey: "mock" };
  }
  // A certificate, when configured, wins over any key: it is the reason to
  // have no key at all.
  const certificate = rolesAnywhere();
  if (certificate) return certificate;
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

/**
 * Sanitised rather than rejected: an operator name with a space should not fail
 * every scan. Truncated to AWS's 64 characters and never empty, since the trust
 * policy requires the key present. Pure, so it is testable without reloading
 * this module.
 */
/** Characters AWS permits in SourceIdentity, per the AssumeRole API reference. */
const SOURCE_IDENTITY_ALLOWED = /[^A-Za-z0-9_+=,.@-]/g;

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

let rolesAnywhereCache: AwsCredentialIdentityProvider | null | undefined;

/**
 * This pod's Roles Anywhere provider, shared by every client so they share one
 * session, or null when it is not configured. Half a configuration is refused
 * at startup (`hostedMode.ts`), so here it is all or nothing.
 */
export function rolesAnywhere(): AwsCredentialIdentityProvider | null {
  if (rolesAnywhereCache !== undefined) return rolesAnywhereCache;
  const certificatePath = cfg.ROLES_ANYWHERE_CERTIFICATE;
  const privateKeyPath = cfg.ROLES_ANYWHERE_PRIVATE_KEY;
  const trustAnchorArn = cfg.ROLES_ANYWHERE_TRUST_ANCHOR_ARN;
  const profileArn = cfg.ROLES_ANYWHERE_PROFILE_ARN;
  const roleArn = cfg.ROLES_ANYWHERE_ROLE_ARN;
  rolesAnywhereCache =
    certificatePath && privateKeyPath && trustAnchorArn && profileArn && roleArn
      ? rolesAnywhereProvider({
          certificatePath,
          privateKeyPath,
          trustAnchorArn,
          profileArn,
          roleArn,
        })
      : null;
  return rolesAnywhereCache;
}

{
  const problem = targetRoleProblem();
  if (problem) console.warn(`\n  AWS_TARGET_ROLE_ARN cannot be assumed.\n  ${problem}\n`);
}
