/**
 * Remediation: the fix, written out, and never applied (ADR-005, 007, 009). A
 * remediation is a document an engineer reads and runs themselves.
 *
 * Two properties make that useful rather than glib:
 *
 * - **Computed, not generated.** The commands come from the same evidence as
 *   the verdict, by the argument in ADR-004. A model asked to write
 *   `put-public-access-block` *usually* gets it right, and "usually" is not a
 *   property you want in a command pasted into production.
 * - **`caution` is required.** A fix without a blast radius is a trap: the
 *   worst output here would be a confident one-liner that takes a public asset
 *   host offline.
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
