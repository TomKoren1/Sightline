/** Unused access: keys deactivated, passwords removed, roles deleted - carefully. */

import type { Remediation } from "@sightline/shared";
import { shellQuote } from "@sightline/shared";
import type { RemediationInput } from "./input.js";
import type { PolicyRef } from "./iam.js";

export interface StaleCredentials {
  passwordEnabled?: boolean;
  passwordLastUsedAt?: string | null;
  accessKeys?: { slot: number; active: boolean; lastUsedAt?: string | null }[];
}

/**
 * Deactivate before delete, for keys: an inactive key can be switched back
 * on in a second if something did need it, and its last-used date says
 * nothing ran on it for months. The role is deleted only after detaching
 * what it holds, which IAM requires, with a last look at its last use first.
 */
export function unusedRemediations(input: RemediationInput): Remediation[] {
  if (!input.derived.isUnused) return [];
  const name = shellQuote(input.name);
  if (input.kind === "IamUser") {
    const credentials = (input.properties["credentials"] ?? {}) as StaleCredentials;
    const reason = input.derived.unusedReason ?? "";
    const out: Remediation[] = [];
    const staleKeys = (credentials.accessKeys ?? []).filter(
      (k) => k.active && reason.includes(`access key ${k.slot}`),
    );
    if (staleKeys.length > 0) {
      out.push({
        id: "iam-deactivate-stale-keys",
        addresses: "unused",
        title: `Deactivate the unused access key${staleKeys.length > 1 ? "s" : ""}`,
        summary:
          "Switches the key off without deleting it, so it can be switched back on if something turns out to need it.",
        caution:
          "Anything still holding the key - a CI secret, a cron job, a laptop - starts getting " +
          "InvalidClientTokenId. Its last-used date says nothing has for months, but a job that " +
          "runs quarterly would not show. Delete the key after a few weeks with no complaints.",
        risk: "low",
        cli: [
          `# which key is which (the credential report numbers them in creation order):`,
          `aws iam list-access-keys --user-name ${name}`,
          `aws iam update-access-key --user-name ${name} --status Inactive \\`,
          `  --access-key-id <AccessKeyId from above>`,
        ],
        verify: `aws iam list-access-keys --user-name ${name} --query 'AccessKeyMetadata[].[AccessKeyId,Status]'`,
      });
    }
    if (credentials.passwordEnabled && reason.includes("Console password")) {
      out.push({
        id: "iam-delete-stale-login-profile",
        addresses: "unused",
        title: "Remove the unused console password",
        summary: "Deletes the user's console sign-in. Its access keys, if any, are untouched.",
        caution:
          "The person, if there is one, can no longer sign in to the console. An administrator " +
          "can give them a new password with create-login-profile if they need it back.",
        risk: "medium",
        cli: [`aws iam delete-login-profile --user-name ${name}`],
        verify: `aws iam get-login-profile --user-name ${name}  # expect NoSuchEntity`,
      });
    }
    return out;
  }
  if (input.kind !== "IamRole") return [];
  const attached = (input.properties["attachedPolicies"] ?? []) as PolicyRef[];
  const inline = (input.properties["inlinePolicies"] ?? []) as PolicyRef[];
  return [
    {
      id: "iam-delete-unused-role",
      addresses: "unused",
      title: "Delete the unused role",
      summary:
        "Removes standing access nobody has exercised. IAM requires its policies and instance profiles to go first.",
      caution:
        "Whatever assumes it - a pipeline, another account, an instance launched from an old " +
        "template - fails from then on, and a deleted role cannot be restored: recreating it " +
        "gives it a new id, which breaks trust policies naming the old one. Check the last use " +
        "again first, and keep the policy documents if you might want it back.",
      risk: "medium",
      cli: [
        `# 1. confirm it is still unused (read-only):`,
        `aws iam get-role --role-name ${name} --query Role.RoleLastUsed`,
        `# 2. take it out of any instance profile:`,
        `aws iam list-instance-profiles-for-role --role-name ${name}`,
        `# aws iam remove-role-from-instance-profile --role-name ${name} --instance-profile-name <name>`,
        `# 3. remove its policies, then the role:`,
        ...attached
          .filter((p) => p.policyArn)
          .map(
            (p) =>
              `aws iam detach-role-policy --role-name ${name} --policy-arn ${shellQuote(p.policyArn!)}`,
          ),
        ...inline
          .filter((p) => p.policyName)
          .map(
            (p) =>
              `aws iam delete-role-policy --role-name ${name} --policy-name ${shellQuote(p.policyName!)}`,
          ),
        `aws iam delete-role --role-name ${name}`,
      ],
      verify: `aws iam get-role --role-name ${name}  # expect NoSuchEntity`,
    },
  ];
}
