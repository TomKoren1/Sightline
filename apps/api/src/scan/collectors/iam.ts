/**
 * IAM roles, their policies, and instance profiles.
 *
 * This collector does more work per resource than any other, because the
 * question it has to serve - "which roles have admin access?" - cannot be
 * answered from a listing. A role's effective permissions are the union of its
 * attached managed policies and its inline policies, and the *name* of a
 * policy tells you nothing: the mock account contains a role called
 * `LegacyDeployRole` whose inline policy grants `*` on `*`.
 *
 * So every policy document is fetched and kept, and the admin verdict is
 * computed from the documents by an analyser that can be unit tested.
 *
 * Managed policy documents are fetched once and cached. `AdministratorAccess`
 * is attached to several roles, and on a real account a handful of managed
 * policies are attached to hundreds - re-fetching each time is the difference
 * between one API call and several hundred.
 */

import {
  paginateListRoles,
  paginateListInstanceProfiles,
  paginateListUsers,
  ListAttachedRolePoliciesCommand,
  ListRolePoliciesCommand,
  GetRolePolicyCommand,
  ListAttachedUserPoliciesCommand,
  ListUserPoliciesCommand,
  GetUserPolicyCommand,
  GetPolicyCommand,
  GetPolicyVersionCommand,
} from "@aws-sdk/client-iam";
import type { Relationship, Resource } from "@daveio/shared";

import { iamClient } from "../../aws/clients.js";
import { iamArn, tagsToRecord } from "../../aws/arns.js";
import type { CollectorContext, CollectorOutput } from "./types.js";

/** A policy document, decoded. AWS returns these URL-encoded. */
export interface PolicyDocument {
  Version?: string;
  Statement?: Array<{
    Sid?: string;
    Effect?: string;
    Action?: string | string[];
    NotAction?: string | string[];
    Resource?: string | string[];
    Condition?: Record<string, unknown>;
  }>;
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

export async function collectIam(ctx: CollectorContext): Promise<CollectorOutput> {
  const client = iamClient();
  const resources: Resource[] = [];
  const relationships: Relationship[] = [];

  /** Managed policy ARN -> its default-version document. Fetched at most once. */
  const managedPolicyCache = new Map<string, PolicyDocument | null>();

  async function managedPolicyDocument(policyArn: string): Promise<PolicyDocument | null> {
    const cached = managedPolicyCache.get(policyArn);
    if (cached !== undefined) return cached;

    let document: PolicyDocument | null = null;
    try {
      const meta = await client.send(new GetPolicyCommand({ PolicyArn: policyArn }));
      const versionId = meta.Policy?.DefaultVersionId;
      if (versionId) {
        const version = await client.send(
          new GetPolicyVersionCommand({ PolicyArn: policyArn, VersionId: versionId }),
        );
        document = decodePolicyDocument(version.PolicyVersion?.Document as string | undefined);
      }
    } catch (err) {
      // A policy we cannot read is recorded as unreadable rather than absent,
      // so the admin analyser can say "unknown" instead of silently "no".
      console.warn(
        `  iam: could not read ${policyArn}: ${err instanceof Error ? err.message : err}`,
      );
    }

    managedPolicyCache.set(policyArn, document);
    return document;
  }

  // --- Roles --------------------------------------------------------------
  for await (const page of paginateListRoles({ client }, {})) {
    for (const role of page.Roles ?? []) {
      if (!role.RoleName) continue;
      const roleName = role.RoleName;
      const arn = role.Arn ?? iamArn(ctx.accountId, "role", roleName);

      const attached = await client
        .send(new ListAttachedRolePoliciesCommand({ RoleName: roleName }))
        .catch(() => null);

      const attachedPolicies: Array<{
        policyArn: string;
        policyName: string;
        document: PolicyDocument | null;
      }> = [];
      for (const p of attached?.AttachedPolicies ?? []) {
        if (!p.PolicyArn) continue;
        attachedPolicies.push({
          policyArn: p.PolicyArn,
          policyName: p.PolicyName ?? p.PolicyArn.split("/").pop() ?? p.PolicyArn,
          document: await managedPolicyDocument(p.PolicyArn),
        });
      }

      const inlineNames = await client
        .send(new ListRolePoliciesCommand({ RoleName: roleName }))
        .catch(() => null);

      const inlinePolicies: Array<{ policyName: string; document: PolicyDocument | null }> = [];
      for (const policyName of inlineNames?.PolicyNames ?? []) {
        const inline = await client
          .send(new GetRolePolicyCommand({ RoleName: roleName, PolicyName: policyName }))
          .catch(() => null);
        inlinePolicies.push({
          policyName,
          document: decodePolicyDocument(inline?.PolicyDocument as string | undefined),
        });
      }

      const tags = tagsToRecord(role.Tags);
      const trustPolicy = decodePolicyDocument(role.AssumeRolePolicyDocument);

      resources.push({
        arn,
        kind: "IamRole",
        name: roleName,
        region: null,
        accountId: ctx.accountId,
        tags,
        properties: {
          roleName,
          path: role.Path ?? "/",
          description: role.Description ?? null,
          createdAt: role.CreateDate?.toISOString() ?? null,
          maxSessionDuration: role.MaxSessionDuration ?? null,
          trustPolicy,
          /** Service principals allowed to assume this role, e.g. ec2, lambda. */
          trustedServices: (trustPolicy?.Statement ?? [])
            .flatMap((s) => {
              const principal = (s as { Principal?: { Service?: string | string[] } }).Principal;
              const svc = principal?.Service;
              return svc ? (Array.isArray(svc) ? svc : [svc]) : [];
            })
            .filter(Boolean),
          attachedPolicies,
          inlinePolicies,
          attachedPolicyCount: attachedPolicies.length,
          inlinePolicyCount: inlinePolicies.length,
        },
        derived: {},
        raw: role,
      });

      for (const p of attachedPolicies) {
        relationships.push({
          from: arn,
          to: p.policyArn,
          type: "HAS_POLICY",
          properties: { policyName: p.policyName, kind: "managed" },
        });
        // Managed policies are shared, including AWS-owned ones outside this
        // account. Emit a node for each so the edge has a target to land on.
        if (!resources.some((r) => r.arn === p.policyArn)) {
          const awsManaged = p.policyArn.startsWith("arn:aws:iam::aws:");
          resources.push({
            arn: p.policyArn,
            kind: "IamPolicy",
            name: p.policyName,
            region: null,
            accountId: awsManaged ? "aws" : ctx.accountId,
            tags: {},
            properties: {
              policyName: p.policyName,
              awsManaged,
              document: p.document,
            },
            derived: {},
          });
        }
      }
    }
  }

  // --- Instance profiles --------------------------------------------------
  // The join between an EC2 instance and the role it runs as.
  for await (const page of paginateListInstanceProfiles({ client }, {})) {
    for (const profile of page.InstanceProfiles ?? []) {
      if (!profile.InstanceProfileName) continue;
      const arn =
        profile.Arn ?? iamArn(ctx.accountId, "instance-profile", profile.InstanceProfileName);

      resources.push({
        arn,
        kind: "InstanceProfile",
        name: profile.InstanceProfileName,
        region: null,
        accountId: ctx.accountId,
        tags: tagsToRecord(profile.Tags),
        properties: {
          instanceProfileName: profile.InstanceProfileName,
          roleNames: (profile.Roles ?? []).map((r) => r.RoleName).filter(Boolean),
        },
        derived: {},
        raw: profile,
      });

      for (const role of profile.Roles ?? []) {
        if (!role.RoleName) continue;
        relationships.push({
          from: arn,
          to: role.Arn ?? iamArn(ctx.accountId, "role", role.RoleName),
          type: "PROVIDES_ROLE",
        });
      }
    }
  }

  /**
   * --- Users ---------------------------------------------------------------
   *
   * Users carry their policies for the same reason roles do: the admin
   * analyser asks "which principals are administrators?", and for a long time
   * this collector answered only for roles. Users were inventoried with their
   * name and creation date and nothing about what they could do, so an account
   * whose only administrators were IAM users reported no administrators at
   * all - a false negative in the one analysis a reader is most likely to check
   * first. Found against a real account with two `AdministratorAccess` users
   * and an empty findings panel (engineering log #29).
   *
   * Roles remain the more interesting case in a mature account, but "no admin
   * roles" and "no admins" are different statements and the tool was making the
   * second while only checking the first.
   */
  for await (const page of paginateListUsers({ client }, {})) {
    for (const user of page.Users ?? []) {
      if (!user.UserName) continue;
      const userName = user.UserName;

      const attached = await client
        .send(new ListAttachedUserPoliciesCommand({ UserName: userName }))
        .catch(() => null);

      const attachedPolicies: Array<{
        policyArn: string;
        policyName: string;
        document: PolicyDocument | null;
      }> = [];
      for (const p of attached?.AttachedPolicies ?? []) {
        if (!p.PolicyArn) continue;
        attachedPolicies.push({
          policyArn: p.PolicyArn,
          policyName: p.PolicyName ?? p.PolicyArn.split("/").pop() ?? p.PolicyArn,
          // Shares the cache with roles, so AdministratorAccess attached to
          // several principals is fetched once.
          document: await managedPolicyDocument(p.PolicyArn),
        });
      }

      const inlineNames = await client
        .send(new ListUserPoliciesCommand({ UserName: userName }))
        .catch(() => null);

      const inlinePolicies: Array<{ policyName: string; document: PolicyDocument | null }> = [];
      for (const policyName of inlineNames?.PolicyNames ?? []) {
        const inline = await client
          .send(new GetUserPolicyCommand({ UserName: userName, PolicyName: policyName }))
          .catch(() => null);
        inlinePolicies.push({
          policyName,
          document: decodePolicyDocument(inline?.PolicyDocument as string | undefined),
        });
      }

      resources.push({
        arn: user.Arn ?? iamArn(ctx.accountId, "user", userName),
        kind: "IamUser",
        name: userName,
        region: null,
        accountId: ctx.accountId,
        tags: tagsToRecord(user.Tags),
        properties: {
          userName,
          path: user.Path ?? "/",
          createdAt: user.CreateDate?.toISOString() ?? null,
          passwordLastUsed: user.PasswordLastUsed?.toISOString() ?? null,
          attachedPolicies,
          inlinePolicies,
          attachedPolicyCount: attachedPolicies.length,
          inlinePolicyCount: inlinePolicies.length,
        },
        derived: {},
        raw: user,
      });

      for (const p of attachedPolicies) {
        relationships.push({
          from: user.Arn ?? iamArn(ctx.accountId, "user", userName),
          to: p.policyArn,
          type: "HAS_POLICY",
        });
      }
    }
  }

  return { resources, relationships };
}
