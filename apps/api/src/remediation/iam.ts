/** IAM: replacing standing administrator access with scoped grants. */

import type { Remediation } from "@sightline/shared";
import { shellQuote } from "@sightline/shared";
import { documentGrantsAdmin } from "../scan/analysers/policy.js";
import type { GroupPolicy, PolicyDocument } from "../scan/collectors/iam.js";
import type { RemediationInput } from "./input.js";

export interface PolicyRef {
  policyArn?: string;
  policyName?: string;
  document?: PolicyDocument | null;
}

export function iamRemediations(input: RemediationInput): Remediation[] {
  if (!input.derived.isAdmin) return [];

  const isUser = input.kind === "IamUser";
  const noun = isUser ? "user" : "role";
  const nameFlag = isUser ? "--user-name" : "--role-name";
  const name = shellQuote(input.name);
  const out: Remediation[] = [];

  const attached = (input.properties["attachedPolicies"] ?? []) as PolicyRef[];
  const inline = (input.properties["inlinePolicies"] ?? []) as PolicyRef[];

  /**
   * Which policy actually grants admin, by ARN, not by guessing from the name.
   *
   * `AdministratorAccess` is the common case but not the only one, and the
   * fixture deliberately contains a role whose admin comes from an inline
   * policy called `LegacyDeployRole` and a user whose comes from one called
   * `BackupHelper`. Detaching the wrong policy is a change that looks like it
   * worked and fixes nothing.
   */
  const adminManaged = attached.filter(
    (p) => typeof p.policyArn === "string" && /(^|\/)AdministratorAccess$/.test(p.policyArn),
  );

  const usedBy = input.usedBy ?? [];
  const usedByText =
    usedBy.length > 0
      ? `${usedBy.map((u) => u.name).join(", ")} currently ${usedBy.length === 1 ? "uses" : "use"} this ${noun}, and will lose every permission it grants the moment this is applied.`
      : isUser
        ? "Nothing in this inventory shows what uses this user — and for a user, that is not evidence it is unused. Its credentials are long-lived and could be in a CI pipeline, a script or a developer's machine."
        : `Nothing in this inventory uses this ${noun}, but the inventory only sees what it can enumerate.`;

  for (const policy of adminManaged) {
    out.push({
      id: `iam-detach-${policy.policyArn?.split("/").pop() ?? "admin"}`,
      addresses: "admin",
      title: `Detach ${policy.policyName ?? "AdministratorAccess"} from this ${noun}`,
      summary:
        `Removes the managed policy granting Action "*" on Resource "*". Attach a scoped policy ` +
        "with only the permissions actually needed **before** detaching, not after.",
      caution: `This removes all permissions in one step. ${usedByText} Determine what it actually calls first — CloudTrail or IAM Access Analyzer's generated policies are the usual way — then attach the replacement, verify, and only then detach.`,
      risk: "high",
      cli: [
        `# 1. find out what it really uses (read-only, safe to run now):`,
        `aws iam generate-service-last-accessed-details --arn ${shellQuote(input.arn)}`,
        `# 2. attach a scoped replacement, then verify the workload still works`,
        `# 3. only then:`,
        `aws iam detach-${noun}-policy ${nameFlag} ${name} \\`,
        `  --policy-arn ${shellQuote(policy.policyArn ?? "")}`,
      ],
      verify: `aws iam list-attached-${noun}-policies ${nameFlag} ${name}`,
    });
  }

  // Only the inline policies that grant admin themselves: offering to rewrite
  // an unrelated one, with a summary saying it grants "*", fixes nothing.
  for (const policy of inline) {
    if (!policy.policyName || !documentGrantsAdmin(policy.document ?? null).yes) continue;
    out.push({
      id: `iam-inline-${policy.policyName}`,
      addresses: "admin",
      title: `Replace the inline policy ${policy.policyName}`,
      summary:
        `The admin grant is inline, so the policy name says nothing about what it does — ` +
        `${policy.policyName} grants Action "*" on Resource "*". Rewrite it with the ` +
        "permissions actually required.",
      caution: `Editing in place is a single atomic change with no rollback step. ${usedByText} Save the current document first — the command below does — so it can be restored.`,
      risk: "high",
      cli: [
        `aws iam get-${noun}-policy ${nameFlag} ${name} \\`,
        `  --policy-name ${shellQuote(policy.policyName)} --query PolicyDocument > backup.json`,
        `# write a scoped replacement to scoped.json, then:`,
        `aws iam put-${noun}-policy ${nameFlag} ${name} \\`,
        `  --policy-name ${shellQuote(policy.policyName)} --policy-document file://scoped.json`,
      ],
      verify: `aws iam get-${noun}-policy ${nameFlag} ${name} --policy-name ${shellQuote(policy.policyName)}`,
    });
  }

  if (input.derived.adminVia === "escalation") {
    out.push({
      id: "iam-escalation",
      addresses: "admin",
      title: `Remove the permissions that let this ${noun} make itself an administrator`,
      summary:
        `${input.derived.adminReason ?? "It holds a known privilege-escalation combination."} ` +
        "Removing any one action in the combination closes the path; scoping its Resource to " +
        "named ARNs, or adding a permissions boundary, closes it without removing the capability.",
      caution: `Each action in the path is usually there for a reason. ${usedByText} Narrow the Resource first; remove the action only if nothing needs it.`,
      risk: "medium",
      cli: [
        `# what it has actually called recently (read-only):`,
        `aws iam generate-service-last-accessed-details --arn ${shellQuote(input.arn)}`,
        `# then edit the policies named above, or cap the ${noun} with a boundary:`,
        `aws iam put-${noun}-permissions-boundary ${nameFlag} ${name} \\`,
        `  --permissions-boundary arn:aws:iam::<account>:policy/<boundary>`,
      ],
      verify: `aws iam simulate-principal-policy --policy-source-arn ${shellQuote(input.arn)} --action-names iam:PassRole iam:CreatePolicyVersion`,
    });
  }

  // Admin held through a group is fixed on the group, and fixing it there
  // changes every member, so both routes are offered and the cost named.
  const groupGrants = ((input.properties["groupPolicies"] ?? []) as GroupPolicy[]).filter(
    (p) => documentGrantsAdmin(p.document).yes,
  );
  for (const group of new Set(groupGrants.map((p) => p.groupName))) {
    const policies = groupGrants.filter((p) => p.groupName === group).map((p) => p.policyName);
    out.push({
      id: `iam-group-${group}`,
      addresses: "admin",
      title: `Remove this user from the group ${group}`,
      summary:
        `The admin grant comes from the group, through ${policies.join(", ")}. Removing the ` +
        "membership takes it from this user alone; scoping the group's policy takes it from " +
        "every member.",
      caution: `Removing the membership drops every permission the group gives, not only the admin grant. ${usedByText} Editing the group's policy instead changes every other member at once — list them first.`,
      risk: "high",
      cli: [
        `aws iam get-group --group-name ${shellQuote(group)} --query 'Users[].UserName'`,
        `aws iam remove-user-from-group --group-name ${shellQuote(group)} --user-name ${name}`,
      ],
      verify: `aws iam list-groups-for-user --user-name ${name}`,
    });
  }

  /**
   * Users get one more, and it is usually the more urgent of the two.
   *
   * An admin role is assumed and issues temporary credentials. An admin user
   * has access keys that do not expire, so the exposure is standing rather
   * than scoped to a session — which is why #29 treats a user with admin as a
   * different finding rather than a lesser one.
   */
  if (isUser) {
    out.push({
      id: "iam-user-audit-keys",
      addresses: "admin",
      title: "Audit and rotate this user's long-lived credentials",
      summary:
        "An IAM user's access keys do not expire. Until they are rotated or removed, a leaked " +
        "key is standing administrator access to the whole account with no automatic cutoff.",
      caution:
        "Deactivating a key breaks whatever is using it, immediately and without warning — and " +
        "the thing using it is often a pipeline nobody currently owns. Check `LastUsedDate` " +
        "first, create the replacement key, deploy it, and only then deactivate the old one.",
      risk: "high",
      cli: [
        `aws iam list-access-keys --user-name ${name}`,
        `# for each key id, when was it last used and for what:`,
        `aws iam get-access-key-last-used --access-key-id AKIA...`,
        `# after the replacement is deployed and verified:`,
        `aws iam update-access-key --user-name ${name} --access-key-id AKIA... --status Inactive`,
      ],
      verify: `aws iam list-access-keys --user-name ${name}`,
    });
  }

  return out;
}
