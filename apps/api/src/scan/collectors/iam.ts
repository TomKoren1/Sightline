/**
 * IAM roles, users, groups, their policies, and instance profiles.
 *
 * "Which principals are administrators?" cannot be answered from a listing: a
 * policy's *name* says nothing (the mock holds a `LegacyDeployRole` whose
 * inline policy grants `*` on `*`), so every document is collected and the
 * verdict computed by a unit-testable analyser.
 *
 * One `GetAccountAuthorizationDetails` sweep returns every principal with its
 * inline and attached policies, and every managed policy's versions. The
 * per-principal calls it replaces cost about three requests per role against
 * IAM's global, low rate limit - 10k calls on an account with 3,000 roles.
 * `ListRoles` and `ListUsers` still run, as cheap paged listings, for the few
 * fields the sweep omits (description, session length, password last used).
 * The credential report adds, in two calls for the whole account, what no
 * listing has: whether each user's password and access keys are active, and
 * when each was last used - the evidence for "unused access".
 */

import {
  GenerateCredentialReportCommand,
  GetCredentialReportCommand,
  GetPolicyCommand,
  GetPolicyVersionCommand,
  paginateGetAccountAuthorizationDetails,
  paginateListRoles,
  paginateListUsers,
  type GroupDetail,
  type ManagedPolicyDetail,
  type Role,
  type RoleDetail,
  type User,
  type UserDetail,
} from "@aws-sdk/client-iam";
import type { Relationship, Resource } from "@sightline/shared";

import { iamClient } from "../../aws/clients.js";
import { iamArn, tagsToRecord } from "../../aws/arns.js";
import type { CollectorContext, CollectorOutput } from "./types.js";
import { errorMessage } from "@sightline/shared";

/** A policy document, decoded. AWS returns these URL-encoded. */
export interface PolicyDocument {
  Version?: string;
  Statement?: {
    Sid?: string;
    Effect?: string;
    Action?: string | string[];
    NotAction?: string | string[];
    Resource?: string | string[];
    NotResource?: string | string[];
    Condition?: Record<string, unknown>;
  }[];
}

export function decodePolicyDocument(doc: string | undefined): PolicyDocument | null {
  if (!doc) return null;
  try {
    // Some paths return it already decoded, others URL-encoded. Try both.
    const text = doc.trimStart().startsWith("{") ? doc : decodeURIComponent(doc);
    return JSON.parse(text) as PolicyDocument;
  } catch {
    return null;
  }
}

export interface AttachedPolicy {
  policyArn: string;
  policyName: string;
  document: PolicyDocument | null;
}

export interface InlinePolicy {
  policyName: string;
  document: PolicyDocument | null;
}

/** A policy a user holds through a group, kept apart so remediation can say so. */
export interface GroupPolicy {
  groupName: string;
  policyName: string;
  kind: "managed" | "inline";
  policyArn?: string;
  document: PolicyDocument | null;
}

/** One user's row of the credential report, with AWS's "N/A" and "no_information" as null. */
export interface UserCredentials {
  passwordEnabled: boolean;
  passwordLastUsedAt: string | null;
  mfaActive: boolean;
  accessKeys: {
    slot: 1 | 2;
    active: boolean;
    lastRotatedAt: string | null;
    lastUsedAt: string | null;
    lastUsedService: string | null;
  }[];
}

const reportDate = (value: string | undefined): string | null => {
  if (!value) return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : new Date(at).toISOString();
};
const reportText = (value: string | undefined): string | null =>
  !value || ["N/A", "no_information", "not_supported"].includes(value) ? null : value;

/** The credential report's CSV, by user name. No field in it holds a comma. */
export function parseCredentialReport(csv: string): Map<string, UserCredentials> {
  const [header, ...lines] = csv.trim().split(/\r?\n/);
  const columns = (header ?? "").split(",");
  const users = new Map<string, UserCredentials>();
  for (const line of lines) {
    const cells = line.split(",");
    const at = (name: string) => cells[columns.indexOf(name)];
    const user = at("user");
    // The root user's row, which is not an IAM user and has no node.
    if (!user || user === "<root_account>") continue;
    users.set(user, {
      passwordEnabled: at("password_enabled") === "true",
      passwordLastUsedAt: reportDate(at("password_last_used")),
      mfaActive: at("mfa_active") === "true",
      accessKeys: ([1, 2] as const).map((slot) => ({
        slot,
        active: at(`access_key_${slot}_active`) === "true",
        lastRotatedAt: reportDate(at(`access_key_${slot}_last_rotated`)),
        lastUsedAt: reportDate(at(`access_key_${slot}_last_used_date`)),
        lastUsedService: reportText(at(`access_key_${slot}_last_used_service`)),
      })),
    });
  }
  return users;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The credential report, generating it if AWS has none from the last four
 * hours. `null` when it cannot be read - refused, or still generating after
 * the wait - which the analyser reads as "unknown", never as "unused".
 */
async function credentialReport(
  client: ReturnType<typeof iamClient>,
): Promise<Map<string, UserCredentials> | null> {
  try {
    await client.send(new GenerateCredentialReportCommand({}));
    for (let attempt = 0; attempt < 15; attempt++) {
      try {
        const report = await client.send(new GetCredentialReportCommand({}));
        return parseCredentialReport(Buffer.from(report.Content ?? []).toString("utf8"));
      } catch (err) {
        const name = (err as { name?: string }).name ?? "";
        if (!/ReportInProgress|ReportNotPresent|CredentialReportNotReady/.test(name)) throw err;
        await sleep(1000);
      }
    }
    console.warn("  iam: credential report still generating after 15s; user activity unknown");
  } catch (err) {
    console.warn(`  iam: credential report not read - ${errorMessage(err)}`);
  }
  return null;
}

interface AuthorizationDetails {
  roles: RoleDetail[];
  users: UserDetail[];
  groups: GroupDetail[];
  policies: ManagedPolicyDetail[];
}

export async function collectIam(ctx: CollectorContext): Promise<CollectorOutput> {
  const client = iamClient(ctx);
  const resources: Resource[] = [];
  const relationships: Relationship[] = [];

  const details: AuthorizationDetails = { roles: [], users: [], groups: [], policies: [] };
  for await (const page of paginateGetAccountAuthorizationDetails(
    { client },
    { Filter: ["Role", "User", "Group", "LocalManagedPolicy", "AWSManagedPolicy"] },
  )) {
    details.roles.push(...(page.RoleDetailList ?? []));
    details.users.push(...(page.UserDetailList ?? []));
    details.groups.push(...(page.GroupDetailList ?? []));
    details.policies.push(...(page.Policies ?? []));
  }

  const roleMeta = new Map<string, Role>();
  for await (const page of paginateListRoles({ client }, {})) {
    for (const role of page.Roles ?? []) if (role.RoleName) roleMeta.set(role.RoleName, role);
  }
  const userMeta = new Map<string, User>();
  for await (const page of paginateListUsers({ client }, {})) {
    for (const user of page.Users ?? []) if (user.UserName) userMeta.set(user.UserName, user);
  }

  const credentials = await credentialReport(client);

  /** Managed policy ARN -> its default-version document. */
  const managedDocuments = new Map<string, PolicyDocument | null>();
  for (const policy of details.policies) {
    if (!policy.Arn) continue;
    const version = policy.PolicyVersionList?.find((v) => v.IsDefaultVersion);
    managedDocuments.set(policy.Arn, decodePolicyDocument(version?.Document));
  }

  /**
   * The sweep may omit an AWS-managed policy (it lists those in use, and a
   * partial page or a moto gap can drop one), so fall back to fetching it.
   */
  async function managedPolicyDocument(policyArn: string): Promise<PolicyDocument | null> {
    if (managedDocuments.has(policyArn)) return managedDocuments.get(policyArn) ?? null;
    let document: PolicyDocument | null = null;
    try {
      const meta = await client.send(new GetPolicyCommand({ PolicyArn: policyArn }));
      const versionId = meta.Policy?.DefaultVersionId;
      if (versionId) {
        const version = await client.send(
          new GetPolicyVersionCommand({ PolicyArn: policyArn, VersionId: versionId }),
        );
        document = decodePolicyDocument(version.PolicyVersion?.Document);
      }
    } catch (err) {
      // Recorded as unreadable rather than absent, so the analyser can say
      // "unknown" instead of silently "no".
      console.warn(`  iam: could not read ${policyArn}: ${errorMessage(err)}`);
    }
    managedDocuments.set(policyArn, document);
    return document;
  }

  async function attachedPolicies(
    list: { PolicyArn?: string; PolicyName?: string }[] | undefined,
  ): Promise<AttachedPolicy[]> {
    const out: AttachedPolicy[] = [];
    for (const p of list ?? []) {
      if (!p.PolicyArn) continue;
      out.push({
        policyArn: p.PolicyArn,
        policyName: p.PolicyName ?? p.PolicyArn.split("/").pop() ?? p.PolicyArn,
        document: await managedPolicyDocument(p.PolicyArn),
      });
    }
    return out;
  }

  const inlinePolicies = (
    list: { PolicyName?: string; PolicyDocument?: string }[] | undefined,
  ): InlinePolicy[] =>
    (list ?? [])
      .filter((p) => p.PolicyName)
      .map((p) => ({
        policyName: p.PolicyName!,
        document: decodePolicyDocument(p.PolicyDocument),
      }));

  /** A principal's permissions boundary, with its document, when it has one. */
  async function boundaryOf(
    attached: { PermissionsBoundaryArn?: string } | undefined,
  ): Promise<AttachedPolicy | null> {
    const policyArn = attached?.PermissionsBoundaryArn;
    if (!policyArn) return null;
    return {
      policyArn,
      policyName: policyArn.split("/").pop() ?? policyArn,
      document: await managedPolicyDocument(policyArn),
    };
  }

  const policyNodes = new Set<string>();
  function linkPolicies(from: string, attached: AttachedPolicy[]) {
    for (const p of attached) {
      relationships.push({
        from,
        to: p.policyArn,
        type: "HAS_POLICY",
        properties: { policyName: p.policyName, kind: "managed" },
      });
      // Managed policies are shared, including AWS-owned ones outside this
      // account. Emit a node for each so the edge has a target to land on.
      if (policyNodes.has(p.policyArn)) continue;
      policyNodes.add(p.policyArn);
      const awsManaged = p.policyArn.startsWith("arn:aws:iam::aws:");
      resources.push({
        arn: p.policyArn,
        kind: "IamPolicy",
        name: p.policyName,
        region: null,
        accountId: awsManaged ? "aws" : ctx.accountId,
        tags: {},
        properties: { policyName: p.policyName, awsManaged, document: p.document },
        derived: {},
      });
    }
  }

  // --- Roles --------------------------------------------------------------
  const instanceProfiles = new Map<
    string,
    { name: string; roles: { name: string; arn: string }[] }
  >();
  for (const role of details.roles) {
    if (!role.RoleName) continue;
    const roleName = role.RoleName;
    const arn = role.Arn ?? iamArn(ctx.accountId, "role", roleName);
    const meta = roleMeta.get(roleName);
    const attached = await attachedPolicies(role.AttachedManagedPolicies);
    const inline = inlinePolicies(role.RolePolicyList);
    const trustPolicy = decodePolicyDocument(role.AssumeRolePolicyDocument);

    resources.push({
      arn,
      kind: "IamRole",
      name: roleName,
      region: null,
      accountId: ctx.accountId,
      tags: tagsToRecord(role.Tags),
      properties: {
        roleName,
        path: role.Path ?? "/",
        description: meta?.Description ?? null,
        createdAt: role.CreateDate?.toISOString() ?? null,
        maxSessionDuration: meta?.MaxSessionDuration ?? null,
        lastUsedAt: role.RoleLastUsed?.LastUsedDate?.toISOString() ?? null,
        permissionsBoundary: await boundaryOf(role.PermissionsBoundary),
        trustPolicy,
        /** Service principals allowed to assume this role, e.g. ec2, lambda. */
        trustedServices: (trustPolicy?.Statement ?? [])
          .flatMap((s) => {
            const principal = (s as { Principal?: { Service?: string | string[] } }).Principal;
            const svc = principal?.Service;
            return svc ? (Array.isArray(svc) ? svc : [svc]) : [];
          })
          .filter(Boolean),
        attachedPolicies: attached,
        inlinePolicies: inline,
        attachedPolicyCount: attached.length,
        inlinePolicyCount: inline.length,
      },
      derived: {},
      raw: role,
    });
    linkPolicies(arn, attached);

    for (const profile of role.InstanceProfileList ?? []) {
      if (!profile.InstanceProfileName) continue;
      const profileArn =
        profile.Arn ?? iamArn(ctx.accountId, "instance-profile", profile.InstanceProfileName);
      const entry = instanceProfiles.get(profileArn) ?? {
        name: profile.InstanceProfileName,
        roles: [],
      };
      entry.roles.push({ name: roleName, arn });
      instanceProfiles.set(profileArn, entry);
    }
  }

  // --- Instance profiles --------------------------------------------------
  // The join between an EC2 instance and the role it runs as. A profile with
  // no role grants nothing, so the ones the role sweep reaches are the ones
  // that matter.
  for (const [arn, profile] of instanceProfiles) {
    resources.push({
      arn,
      kind: "InstanceProfile",
      name: profile.name,
      region: null,
      accountId: ctx.accountId,
      tags: {},
      properties: {
        instanceProfileName: profile.name,
        roleNames: profile.roles.map((r) => r.name),
      },
      derived: {},
    });
    for (const role of profile.roles) {
      relationships.push({ from: arn, to: role.arn, type: "PROVIDES_ROLE" });
    }
  }

  // --- Groups -------------------------------------------------------------
  // Collected because a user's permissions include its groups': a user with
  // no policies of its own can be an administrator through one.
  const groupPolicies = new Map<string, GroupPolicy[]>();
  const groupArns = new Map<string, string>();
  for (const group of details.groups) {
    if (!group.GroupName) continue;
    const groupName = group.GroupName;
    const arn = group.Arn ?? iamArn(ctx.accountId, "group", groupName);
    groupArns.set(groupName, arn);
    const attached = await attachedPolicies(group.AttachedManagedPolicies);
    const inline = inlinePolicies(group.GroupPolicyList);
    groupPolicies.set(groupName, [
      ...attached.map((p) => ({ groupName, kind: "managed" as const, ...p })),
      ...inline.map((p) => ({ groupName, kind: "inline" as const, ...p })),
    ]);

    resources.push({
      arn,
      kind: "IamGroup",
      name: groupName,
      region: null,
      accountId: ctx.accountId,
      tags: {},
      properties: {
        groupName,
        path: group.Path ?? "/",
        createdAt: group.CreateDate?.toISOString() ?? null,
        attachedPolicies: attached,
        inlinePolicies: inline,
      },
      derived: {},
      raw: group,
    });
    linkPolicies(arn, attached);
  }

  // --- Users --------------------------------------------------------------
  // Users carry their policies for the same reason roles do: an account whose
  // only administrators are IAM users once reported no administrators at all.
  for (const user of details.users) {
    if (!user.UserName) continue;
    const userName = user.UserName;
    const arn = user.Arn ?? iamArn(ctx.accountId, "user", userName);
    const meta = userMeta.get(userName);
    const attached = await attachedPolicies(user.AttachedManagedPolicies);
    const inline = inlinePolicies(user.UserPolicyList);
    const groups = (user.GroupList ?? []).filter(Boolean);

    resources.push({
      arn,
      kind: "IamUser",
      name: userName,
      region: null,
      accountId: ctx.accountId,
      tags: tagsToRecord(user.Tags),
      properties: {
        userName,
        path: user.Path ?? "/",
        createdAt: user.CreateDate?.toISOString() ?? null,
        passwordLastUsed: meta?.PasswordLastUsed?.toISOString() ?? null,
        /** `null` when the credential report could not be read. */
        credentials: credentials ? (credentials.get(userName) ?? null) : null,
        permissionsBoundary: await boundaryOf(user.PermissionsBoundary),
        groups,
        attachedPolicies: attached,
        inlinePolicies: inline,
        groupPolicies: groups.flatMap((g) => groupPolicies.get(g) ?? []),
        attachedPolicyCount: attached.length,
        inlinePolicyCount: inline.length,
      },
      derived: {},
      raw: user,
    });
    linkPolicies(arn, attached);
    for (const groupName of groups) {
      relationships.push({
        from: arn,
        to: groupArns.get(groupName) ?? iamArn(ctx.accountId, "group", groupName),
        type: "MEMBER_OF",
      });
    }
  }

  return { resources, relationships };
}
