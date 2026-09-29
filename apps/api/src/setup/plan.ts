/**
 * What `npm run setup` intends to do, decided before anything happens.
 *
 * Separated from the script so the decisions are testable without prompting,
 * running AWS, or writing files. The script's job is to gather inputs, show this,
 * ask, and then carry it out; everything judgemental lives here.
 */

import { CONNECTION_ENV_KEYS, OTHER_MANAGED_ENV_KEYS, readOnlyRoleArn } from "@daveio/shared";

import type { EnvEdit } from "./envFile.js";

/** Keys whose values must never be printed, even to the user's own terminal. */
const SECRET_KEYS = new Set<string>(["AWS_EXTERNAL_ID", "ANTHROPIC_API_KEY"]);

/**
 * Show enough to confirm which value is which, and no more.
 *
 * The ExternalId is a credential - the role template says so - and the LLM key
 * obviously is. Both are written to `.env` by this script, so neither needs to
 * appear in a scrollback that may be pasted into an issue later.
 */
export function maskForDisplay(key: string, value: string): string {
  if (!SECRET_KEYS.has(key) || value === "") return value;
  if (value.length <= 8) return "•".repeat(value.length);
  return `${value.slice(0, 4)}${"•".repeat(Math.max(4, value.length - 8))}${value.slice(-4)}`;
}

/** The ExternalId `.env.example` ships, which is documentation rather than a value. */
export const PLACEHOLDER_EXTERNAL_ID = "local-dev-external-id-0000";

/**
 * Keep an ExternalId that is already in use; generate one only when there is none.
 *
 * Re-running setup must not rotate a working secret. The stack's trust policy
 * requires the value `.env` holds, so generating a fresh one on every run would
 * mean every re-run invalidates the connection until the stack is redeployed with
 * the new value - the script would be the thing that breaks the setup it just
 * made. `--dry-run` showed this as an ExternalId change on a deployment that was
 * already correct, which is how it was noticed.
 */
export function chooseExternalId(
  existing: string | null,
  generate: () => string,
): {
  value: string;
  reused: boolean;
} {
  const usable = existing !== null && existing !== "" && existing !== PLACEHOLDER_EXTERNAL_ID;
  return usable ? { value: existing, reused: true } : { value: generate(), reused: false };
}

export interface RealConnectionInput {
  accountId: string;
  region: string;
  externalId: string;
  scanRegions: string;
}

/**
 * The `.env` changes that point this deployment at a real account.
 *
 * `AWS_TARGET_ROLE_ARN` is built from the account id rather than accepted as a
 * string, so the value written is necessarily the role the stack creates. Pasting
 * the wrong ARN there is the mistake that produced `Invalid principal in policy`
 * on a real account (engineering log #46), and this removes the opportunity.
 */
export function realConnectionEdits(input: RealConnectionInput): EnvEdit[] {
  return [
    { key: "AWS_MODE", value: "real" },
    { key: "AWS_TARGET_ROLE_ARN", value: readOnlyRoleArn(input.accountId) },
    { key: "AWS_EXTERNAL_ID", value: input.externalId },
    { key: "AWS_REGION", value: input.region },
    { key: "AWS_SCAN_REGIONS", value: input.scanRegions },
  ];
}

/**
 * The changes that put it back on the mock account.
 *
 * Deliberately does **not** clear `AWS_TARGET_ROLE_ARN` or `AWS_EXTERNAL_ID`:
 * switching to the demo account should not throw away a connection that took
 * effort to establish, and `activeConnection()` ignores them in mock mode anyway.
 */
export function mockConnectionEdits(): EnvEdit[] {
  return [{ key: "AWS_MODE", value: "mock" }];
}

/**
 * The two lines a containerised deployment needs to see the host's AWS profile.
 *
 * Written only when the API is containerised, because on a host the credential
 * chain finds `~/.aws` by itself and these would be noise. `COMPOSE_PATH_SEPARATOR`
 * is set explicitly: the default differs by platform, and a `:`-separated value
 * is not parsed the same way everywhere.
 */
export function composeMountEdits(): EnvEdit[] {
  return [
    { key: "COMPOSE_PATH_SEPARATOR", value: ":" },
    { key: "COMPOSE_FILE", value: "docker-compose.yml:deploy/compose.aws-profile.yml" },
  ];
}

export function anthropicKeyEdits(key: string): EnvEdit[] {
  return [{ key: "ANTHROPIC_API_KEY", value: key }];
}

/**
 * Every key this script is allowed to write.
 *
 * Asserted against the edits actually produced, so a new edit has to be declared
 * here before it can be applied. That is what makes "it only touches what it
 * declares" enforceable rather than aspirational — and the shared lists exclude
 * every credential variable, so automation cannot write an access key.
 */
export const WRITABLE_KEYS: ReadonlySet<string> = new Set<string>([
  ...CONNECTION_ENV_KEYS,
  ...OTHER_MANAGED_ENV_KEYS,
]);

/** Reject an edit set that strays outside the declared keys. */
export function undeclaredEdits(edits: EnvEdit[]): string[] {
  return edits.map((e) => e.key).filter((key) => !WRITABLE_KEYS.has(key));
}
