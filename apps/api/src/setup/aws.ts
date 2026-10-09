/**
 * The AWS CLI calls `npm run setup` makes, and how their failures are explained.
 *
 * Shells out to `aws` rather than using the SDK, for one reason that matters: the
 * user's credentials, SSO sessions and named profiles are already configured for
 * that CLI. Reimplementing the credential chain in the script would mean a second
 * thing that can disagree with the tool they already use.
 *
 * Every call goes through `execFile` with an argument **vector**, never a composed
 * command line, so no value a user supplies can be interpreted as shell syntax.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { deployCommandArgs, STACK_NAME, type DeployCommandInput } from "@sightline/shared";

const run = promisify(execFile);

export interface AwsResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Run the AWS CLI. Never throws; the caller decides what a failure means. */
export async function aws(args: string[], timeoutMs = 120_000): Promise<AwsResult> {
  try {
    const { stdout, stderr } = await run("aws", args, {
      timeout: timeoutMs,
      // A large stack event list is bigger than the default 1MB.
      maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true, stdout, stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string; code?: string };
    return {
      ok: false,
      stdout: e.stdout ?? "",
      // ENOENT carries no stderr, and "is the AWS CLI installed" is the single
      // most likely first failure.
      stderr: e.stderr || e.message || String(e.code ?? "unknown error"),
    };
  }
}

/** Whether the AWS CLI is on PATH at all, checked before anything else. */
export async function awsCliVersion(): Promise<string | null> {
  const res = await aws(["--version"], 15_000);
  if (!res.ok) return null;
  return (res.stdout || res.stderr).trim().split("\n")[0] ?? null;
}

export interface CallerIdentity {
  account: string;
  arn: string;
  userId: string;
}

export async function callerIdentity(profile?: string): Promise<CallerIdentity | null> {
  const args = ["sts", "get-caller-identity", "--output", "json"];
  if (profile) args.push("--profile", profile);
  const res = await aws(args, 30_000);
  if (!res.ok) return null;
  try {
    const parsed = JSON.parse(res.stdout) as { Account?: string; Arn?: string; UserId?: string };
    if (!parsed.Account || !parsed.Arn) return null;
    return { account: parsed.Account, arn: parsed.Arn, userId: parsed.UserId ?? "" };
  } catch {
    return null;
  }
}

/** Profiles the user has configured, for the prompt. Empty is normal. */
export async function listProfiles(): Promise<string[]> {
  const res = await aws(["configure", "list-profiles"], 15_000);
  if (!res.ok) return [];
  return res.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

export async function deployStack(
  input: DeployCommandInput,
): Promise<{ ok: boolean; output: string }> {
  // The same vector the Connection screen displays, so what a reader is told to
  // run and what this runs are one definition.
  const res = await aws(deployCommandArgs(input), 600_000);
  return { ok: res.ok, output: [res.stdout, res.stderr].filter(Boolean).join("\n").trim() };
}

/**
 * Why the stack failed, from CloudFormation's own event log.
 *
 * `aws cloudformation deploy` prints "Failed to create/update the stack" and tells
 * you to go and look, which is one more step than necessary when the script can
 * look itself. Both failures seen on a real account are explained in the caller.
 */
/** A failed stack event, as `describe-stack-events` reports it. */
export type FailureEvent = [timestamp: string, reason: string | null];

/**
 * Failure reasons from **this** attempt, not from the stack's history.
 *
 * Pure, so the filtering is testable without AWS. Extracted because getting it
 * wrong is silent: a stack that failed once keeps those events for ever, so an
 * unfiltered query attributes every future failure to the oldest one it finds.
 *
 * Observed doing exactly that. A deploy that failed before CloudFormation was
 * even reached - the template file was missing - was reported as
 * `Invalid principal in policy`, an unrelated failure from twelve hours earlier,
 * with the real error suppressed. A confident wrong diagnosis is worse than none.
 *
 * A small grace period is allowed because the CLI's clock and CloudFormation's
 * need not agree to the millisecond, and an event from the attempt that has just
 * failed is the one thing we must not drop.
 */
export function failureReasonsSince(
  events: FailureEvent[],
  since: Date,
  graceMs = 5_000,
): string[] {
  const floor = since.getTime() - graceMs;
  const reasons = events
    .filter(([timestamp]) => {
      const at = Date.parse(timestamp);
      // An unparseable timestamp is not evidence of recency, so it is dropped
      // rather than assumed current.
      return Number.isFinite(at) && at >= floor;
    })
    .map(([, reason]) => reason)
    .filter((r): r is string => Boolean(r));
  // Deduplicated: a rollback repeats the same reason on several resources.
  return [...new Set(reasons)];
}

/**
 * Why this deploy failed, according to CloudFormation.
 *
 * `since` is when the deploy was started. Events older than that belong to a
 * previous attempt and must never be reported as the cause of this one.
 */
export async function stackFailureReasons(
  region: string,
  since: Date,
  profile?: string,
): Promise<string[]> {
  const args = [
    "cloudformation",
    "describe-stack-events",
    "--stack-name",
    STACK_NAME,
    "--region",
    region,
    "--query",
    "StackEvents[?ResourceStatus=='CREATE_FAILED'||ResourceStatus=='UPDATE_FAILED'].[Timestamp,ResourceStatusReason]",
    "--output",
    "json",
  ];
  if (profile) args.push("--profile", profile);
  const res = await aws(args, 60_000);
  // A stack that does not exist yet reports an error here, which is not a
  // failure to explain - the caller falls back to the CLI's own message.
  if (!res.ok) return [];
  try {
    return failureReasonsSince(JSON.parse(res.stdout) as FailureEvent[], since);
  } catch {
    return [];
  }
}

/**
 * The stack's `RoleArn` output, read rather than assembled.
 *
 * This is the value the reader previously had to copy by hand, and getting it
 * wrong is what `AWS_TARGET_ROLE_ARN` pointing at the scanner principal looks
 * like: `AccessDenied`, or `NoSuchEntity`.
 */
export async function stackRoleArn(region: string, profile?: string): Promise<string | null> {
  const args = [
    "cloudformation",
    "describe-stacks",
    "--stack-name",
    STACK_NAME,
    "--region",
    region,
    "--query",
    "Stacks[0].Outputs[?OutputKey=='RoleArn'].OutputValue | [0]",
    "--output",
    "text",
  ];
  if (profile) args.push("--profile", profile);
  const res = await aws(args, 60_000);
  if (!res.ok) return null;
  const value = res.stdout.trim();
  return value && value !== "None" ? value : null;
}

export async function deleteStack(
  region: string,
  profile?: string,
): Promise<{ ok: boolean; output: string }> {
  const args = ["cloudformation", "delete-stack", "--stack-name", STACK_NAME, "--region", region];
  if (profile) args.push("--profile", profile);
  const res = await aws(args, 120_000);
  return { ok: res.ok, output: [res.stdout, res.stderr].filter(Boolean).join("\n").trim() };
}

/**
 * Turn a stack failure into the specific thing to fix.
 *
 * Both of these were hit on a real account while building this, and neither is
 * guessable from CloudFormation's wording:
 *
 *  - `Invalid principal in policy` means the trust policy names something that
 *    does not exist - almost always because a placeholder ARN was pasted whole
 *    rather than replaced (engineering log #46).
 *  - a `SetSourceIdentity` denial came from an `sts:ExternalId` condition on that
 *    action, where the key is absent from the request context, so it could never
 *    match (engineering log, ExternalId condition fix).
 */
export function explainStackFailure(reasons: string[]): string[] {
  const out: string[] = [];
  for (const reason of reasons) {
    out.push(reason);
    if (/Invalid principal in policy/i.test(reason)) {
      out.push(
        "  → The trust policy names a principal that does not exist in this account. " +
          "That ARN has to be an identity you really have; `aws sts get-caller-identity` reports it.",
      );
    }
    // CloudFormation's wording is "already exists", not the API's AlreadyExists
    // error code. Matching the code alone missed the message a user actually sees.
    if (/already exists|AlreadyExists/i.test(reason)) {
      out.push(
        `  → A role of that name is already there but not owned by the ${STACK_NAME} stack. ` +
          "Delete the role, or deploy with a different RoleName.",
      );
    }
    if (/not authorized to perform/i.test(reason)) {
      out.push(
        "  → The identity running this deploy lacks IAM permissions. It needs to create a role: " +
          "IAMFullAccess and AWSCloudFormationFullAccess are the quick route.",
      );
    }
  }
  return out;
}
