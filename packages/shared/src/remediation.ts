/**
 * Remediation: the fix, written out, and never applied.
 *
 * The product tells you exactly what to change and will not change it. That is
 * not a limitation worked around — it is the same position the rest of the
 * system takes, carried to its conclusion. Sightline holds read-only access by
 * design (ADR-007), the agent cannot express a mutation (ADR-005), and a
 * request to alter the account is refused in code (ADR-009). A remediation is
 * therefore a **document**, not an action: a string an engineer reads, checks
 * against their own knowledge of the system, and runs themselves.
 *
 * Two properties make that useful rather than glib.
 *
 * **It is computed, not generated.** The commands come from the same evidence
 * the verdict came from — which policy statement, which access block, which
 * ingress rule — by the same argument as ADR-004. A model asked to write
 * `aws s3api put-public-access-block` will usually get it right, and "usually"
 * is not a property you want in a command someone pastes into a production
 * account.
 *
 * **Every remediation states what it might break.** `caution` is required, not
 * optional. A fix without a blast radius is a trap, and the most dangerous
 * output this feature could produce is a confident one-liner that takes a
 * public asset host offline or strips the permissions off a role a deployment
 * pipeline depends on. Where the finding is posture rather than exposure, the
 * caution says so plainly — re-enabling a guardrail on a bucket nobody can
 * reach cannot break access that does not exist.
 */

/** How much damage applying this could do if the context is wrong. */
export type RemediationRisk = "low" | "medium" | "high";

/** Which derived verdict a remediation answers. */
export type RemediationAddresses = "public" | "unprotected" | "admin" | "exposed" | "idle";

export interface Remediation {
  /** Stable across runs, so the UI and tests can name one. */
  id: string;
  addresses: RemediationAddresses;
  title: string;
  /** One sentence: what applying this does. */
  summary: string;
  /**
   * What could break, always. A remediation with nothing to say here has not
   * been thought about — every one of these changes production.
   */
  caution: string;
  risk: RemediationRisk;
  /** Exact commands, in order. Strings. Nothing in this system runs them. */
  cli: string[];
  /** Equivalent infrastructure-as-code, where a faithful one exists. */
  terraform?: string;
  /** A read-only command that confirms the change took effect. */
  verify?: string;
}

/**
 * Quote a value for safe inclusion in a shell command.
 *
 * These strings are pasted into a terminal by a human, so a bucket name or tag
 * containing a space, a quote or a `$` must not silently become two arguments
 * or a shell expansion. AWS resource names are more permissive than people
 * expect — S3 bucket names are tame, but tag values and IAM policy names are
 * not — and the failure mode of getting this wrong is a command that runs and
 * does something other than what it reads as.
 *
 * Single quotes, with the standard `'\''` escape for an embedded single quote.
 * Anything that is already a plain safe token is left bare, so the common case
 * stays readable.
 */
export function shellQuote(value: string): string {
  if (value === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
