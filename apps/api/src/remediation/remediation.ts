/**
 * Turning a verdict into the command that would fix it.
 *
 * One function per finding kind, each reading the same evidence the analyser
 * used. Nothing here executes anything, and nothing in this codebase calls AWS
 * with the strings it produces — see `packages/shared/src/remediation.ts` for
 * why that is the design rather than a shortcoming.
 *
 * The rule every generator follows: **if the evidence is not specific enough to
 * write a precise command, say so instead of writing a vague one.** A
 * remediation that names the wrong policy or revokes the wrong rule is worse
 * than no remediation, because it carries the authority of having been
 * computed.
 */

import type { Remediation } from "@sightline/shared";

import { iamRemediations } from "./iam.js";
import { idleRemediations } from "./idle.js";
import type { RemediationInput } from "./input.js";
import { rdsRemediations } from "./rds.js";
import { s3Remediations } from "./s3.js";
import { securityGroupRemediations } from "./securityGroups.js";
import { unusedRemediations } from "./unused.js";

/**
 * Every remediation that applies to one resource, most urgent first.
 *
 * Returns an empty array when there is nothing to fix, which is a meaningful
 * answer rather than a failure — most resources in a healthy account produce
 * none.
 */
export function remediationsFor(input: RemediationInput): Remediation[] {
  const all = [
    ...(input.kind === "S3Bucket" ? s3Remediations(input) : []),
    ...(input.kind === "IamRole" || input.kind === "IamUser" ? iamRemediations(input) : []),
    ...(input.kind === "SecurityGroup" ? securityGroupRemediations(input) : []),
    ...rdsRemediations(input),
    ...idleRemediations(input),
    ...unusedRemediations(input),
  ];

  // Exposure before posture before cost - the order someone should read them.
  const rank: Record<string, number> = {
    public: 0,
    exposed: 1,
    admin: 2,
    unprotected: 3,
    unused: 4,
    idle: 5,
  };
  return all.sort((a, b) => (rank[a.addresses] ?? 9) - (rank[b.addresses] ?? 9));
}
