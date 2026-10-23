/**
 * Getting a customer's AWS account connected, in as few steps as there can be.
 *
 * The shape of it: the customer picks a label, clicks one link, ticks the IAM
 * acknowledgement, presses Create stack, and types twelve digits. Sightline
 * derives the role ARN itself - the role's name is fixed by the template we
 * publish - and then polls `sts:AssumeRole` until it works, so the screen goes
 * green while they are still looking at CloudFormation.
 *
 * Nothing in the stack calls home. A Lambda-backed custom resource could report
 * the role ARN back and remove the twelve digits entirely, and it was rejected:
 * the stack would then create a function and an execution role and make an
 * outbound call to a third party, which is a much harder thing to defend to the
 * security reviewer who reads it before approving. One IAM role and one field is
 * the better trade.
 */

import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import {
  TEMPLATE_VERSION,
  formatDeployCommand,
  quickCreateUrl,
  readOnlyRoleArn,
  terraformSnippet,
} from "@sightline/shared";

import { cfg } from "../config.js";
import { assumablePrincipalArn } from "../aws/principal.js";
import { getSession, resetSession } from "../aws/credentials.js";
import { diagnose, type Diagnosis } from "../connection/diagnose.js";
import {
  accountMismatch,
  externalIdFor,
  getConnection,
  markFailed,
  markVerified,
  type ConnectionSummary,
} from "./connections.js";
import { resolveScanTarget } from "./scanTarget.js";
import type { Scope } from "./scope.js";
import { assumeRoleFailures, verifyDuration } from "../observability/metrics.js";

export interface OnboardingPlan {
  connection: ConnectionSummary;
  /**
   * The shared secret, returned to whoever owns this connection, every time
   * they ask.
   *
   * It was "shown once" when this was first written, which is the reflex and
   * the wrong call. The value grants nothing on its own - assuming the role
   * also needs this service's own credentials, which no customer has - and
   * once their stack is deployed it sits in plaintext inside their trust
   * policy, readable by anyone in their account who can call `iam:GetRole`. So
   * once-only protects against nothing, while making a failed deploy
   * unrecoverable without rotating a secret the deployed stack already
   * contains. Not in `listConnections`, though: it has no business in a
   * response that renders on every page load.
   */
  externalId: string;
  scannerPrincipalArn: string;
  templateUrl: string;
  templateVersion: string;
  /** The one-click link, parameters pre-filled. */
  launchUrl: string;
  /** For an estate where creating a stack from the console is not allowed. */
  cliCommand: string;
  terraform: string;
  /** What the role ARN will be, once they tell us the account id. */
  roleArnPattern: string;
}

/**
 * Configuration onboarding cannot be built without.
 *
 * Hosted mode refuses to start without either of these, so reaching this in a
 * hosted deployment is impossible; a self-hosted operator who wants the link
 * gets a sentence saying what to set rather than a half-built screen.
 */
function published(): { scannerPrincipalArn: string; templateUrl: string } {
  const scannerPrincipalArn = cfg.SCANNER_PRINCIPAL_ARN;
  const templateUrl = cfg.ROLE_TEMPLATE_URL;
  if (!scannerPrincipalArn || !templateUrl) {
    throw new Error(
      "This deployment cannot generate a connection link: set SCANNER_PRINCIPAL_ARN (the " +
        "principal every customer's trust policy will name) and ROLE_TEMPLATE_URL (where the " +
        "role template is published).",
    );
  }
  return { scannerPrincipalArn, templateUrl };
}

export async function onboardingPlan(scope: Scope): Promise<OnboardingPlan> {
  const connection = await getConnection(scope);
  if (!connection) throw new Error("No such connection");
  if (connection.kind === "demo") {
    throw new Error("The demo account needs no connecting - it is already there.");
  }

  const { scannerPrincipalArn, templateUrl } = published();
  const externalId = await externalIdFor(scope);

  /**
   * The principal in `iam` form, whatever form it was configured in.
   *
   * `aws sts get-caller-identity` reports a *session*, so an operator who
   * copied its output configured an `arn:aws:sts::…` value - which the
   * template's own parameter pattern rejects. Converting here means the link
   * always carries something the console will accept.
   *
   * A failure is raised rather than papered over with the original value. That
   * function is deliberately total and says why: a placeholder is what sends
   * somebody to paste the wrong thing, and the wrong principal in a trust
   * policy fails later as an `AccessDenied` that names nothing.
   */
  const resolved = assumablePrincipalArn(scannerPrincipalArn);
  if (!resolved.ok) {
    throw new Error(`SCANNER_PRINCIPAL_ARN cannot be used in a trust policy. ${resolved.reason}`);
  }
  const principal = resolved.principalArn;
  const region = cfg.AWS_REGION;

  return {
    connection,
    externalId,
    scannerPrincipalArn: principal,
    templateUrl,
    templateVersion: TEMPLATE_VERSION,
    /**
     * All three carry the tenant, so the role and stack they name are this
     * tenant's own.
     *
     * Without it two tenants connecting one AWS account would name one role,
     * and a role has one trust policy and therefore one ExternalId - so the
     * second to deploy owned it and the first was refused permanently.
     */
    launchUrl: quickCreateUrl({
      templateUrl,
      scannerPrincipalArn: principal,
      externalId,
      region,
      tenantId: scope.tenantId,
    }),
    cliCommand: formatDeployCommand({
      scannerPrincipalArn: principal,
      externalId,
      region,
      tenantId: scope.tenantId,
    }),
    terraform: terraformSnippet({
      templateUrl,
      scannerPrincipalArn: principal,
      externalId,
      tenantId: scope.tenantId,
    }),
    // Shown so the customer can see what we will derive, rather than being
    // asked to paste it.
    roleArnPattern: readOnlyRoleArn("<your account id>", scope.tenantId),
  };
}

export interface VerifyResult {
  ok: boolean;
  /** The account the role actually reached. Evidence, not a claim. */
  accountId?: string;
  assumedRoleArn?: string;
  durationMs: number;
  /** Present only on failure, and the useful part of one. */
  diagnosis?: Diagnosis;
  /** A refusal that is not a diagnosis - a mismatch against the pinned account. */
  problem?: string;
}

/**
 * Minimum gap between attempts on one connection.
 *
 * The onboarding screen polls this, and each attempt is a real `AssumeRole`
 * against the customer's account. A floor keeps a wedged client from turning
 * into a loop against somebody's STS quota; the UI polls far slower than this,
 * so it never sees a refusal.
 */
const MIN_ATTEMPT_GAP_MS = 2000;
const lastAttempt = new Map<string, number>();

export class VerifyTooSoon extends Error {
  constructor(public readonly retryAfterMs: number) {
    super("Verification was attempted a moment ago; wait before trying again.");
  }
}

/**
 * Try a connection: refuse a retry too soon, then ask the worker, which is the
 * only process holding an identity that can assume the role.
 */
export async function verifyConnection(scope: Scope): Promise<VerifyResult> {
  const previous = lastAttempt.get(scope.connectionId);
  if (previous && Date.now() - previous < MIN_ATTEMPT_GAP_MS) {
    throw new VerifyTooSoon(MIN_ATTEMPT_GAP_MS - (Date.now() - previous));
  }
  lastAttempt.set(scope.connectionId, Date.now());
  // Imported here: the checks module calls back into this one.
  const { requestCheck } = await import("../jobs/connectionChecks.js");
  return requestCheck(scope);
}

/**
 * Try to assume the role, and pin the account if it works. Runs in the worker.
 *
 * Read-only by construction: `AssumeRole` followed by `GetCallerIdentity`,
 * which together prove the trust policy works without touching anything in the
 * customer's account.
 */
export async function performVerification(scope: Scope): Promise<VerifyResult> {
  const started = Date.now();
  const connection = await getConnection(scope);
  if (!connection) throw new Error("No such connection");

  /**
   * Who this service is authenticating as, read before the attempt.
   *
   * Best-effort: if it fails the diagnosis simply loses a detail. When it
   * succeeds it turns "the trust policy does not name this principal" into a
   * sentence naming the principal it should have named, which is frequently
   * not the one the operator had in mind.
   */
  let callerIdentity: string | null = null;
  try {
    callerIdentity =
      (await new STSClient({ region: cfg.AWS_REGION }).send(new GetCallerIdentityCommand({})))
        .Arn ?? null;
  } catch {
    // Falls through; the diagnosis handles a missing identity.
  }

  try {
    const target = await resolveScanTarget(scope);
    // Test the real thing, not a cached session from a previous attempt.
    resetSession(target.connectionId);
    const session = await getSession(target);

    const mismatch = accountMismatch(connection.accountId, session.accountId);
    if (mismatch) {
      await markFailed(scope, mismatch);
      verifyDuration.observe({ outcome: "mismatch" }, (Date.now() - started) / 1000);
      return { ok: false, durationMs: Date.now() - started, problem: mismatch };
    }

    await markVerified(scope, session.accountId);
    verifyDuration.observe({ outcome: "verified" }, (Date.now() - started) / 1000);
    return {
      ok: true,
      accountId: session.accountId,
      assumedRoleArn: session.assumedRoleArn,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    // The customer has a Connect screen, not a `.env`.
    const diagnosis = diagnose(err, callerIdentity, "connect-screen");
    /**
     * By diagnosed cause, not by AWS's message.
     *
     * `diagnose()` already reduces an AccessDenied to which of the three
     * things it actually is - wrong principal, ExternalId mismatch, or a stack
     * predating SourceIdentity - and the code is a closed set. That turns
     * "onboarding is hard" into "they are all failing on the ExternalId".
     */
    assumeRoleFailures.inc({ reason: diagnosis.code });
    verifyDuration.observe({ outcome: "failed" }, (Date.now() - started) / 1000);
    await markFailed(scope, `${diagnosis.problem} ${diagnosis.fix}`.slice(0, 2000));
    return { ok: false, durationMs: Date.now() - started, diagnosis };
  }
}
