/**
 * IAM policy evaluation: is this principal effectively an administrator?
 *
 * Two ways to be one. A *direct* grant is an unconditional Allow of every
 * action on every resource - `*`, or a `NotAction` that still leaves IAM
 * writable. An *escalation* is a set of narrower permissions that lets the
 * principal make itself an administrator: `iam:CreatePolicyVersion` on its own
 * policy, or `iam:PassRole` with `lambda:CreateFunction` and an invoke. Both
 * are reported, because both end in the same place.
 *
 * Identity policies, explicit Deny and permissions boundaries are evaluated.
 * Service control policies, session policies and resource policies are not,
 * so "is an administrator" must be right while "is not" is scoped to what was
 * read. A condition is treated as restricting unless it is a known no-op.
 */

import type { PolicyDocument } from "../collectors/iam.js";

type Statement = NonNullable<PolicyDocument["Statement"]>[number];

const asArray = (v: string | string[] | undefined): string[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];

export interface PolicyRef {
  policyName: string;
  kind: "managed" | "inline";
  document: PolicyDocument | null;
  /** Set when the principal holds this policy through an IAM group. */
  viaGroup?: string;
}

export interface AdminVerdict {
  isAdmin: boolean;
  /** `direct` for a granted `*`, `escalation` for a path to one. */
  adminVia?: "direct" | "escalation";
  /** Human-readable evidence, always populated. */
  reason: string;
  /** Which policy produced the verdict, for the UI and for citations. */
  via?: { policyName: string; kind: "managed" | "inline"; sid?: string; group?: string };
  /** The escalation found, when that is how the principal is an administrator. */
  escalation?: { id: string; actions: string[]; policies: string[] };
}

// --- Matching ---------------------------------------------------------------

const globCache = new Map<string, RegExp>();

/** IAM's wildcard match: `*` any run, `?` one character, case-insensitive. */
function glob(pattern: string): RegExp {
  let re = globCache.get(pattern);
  if (!re) {
    const body = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");
    re = new RegExp(`^${body}$`, "i");
    globCache.set(pattern, re);
  }
  return re;
}

function coversAction(stmt: Statement, action: string): boolean {
  if (stmt.NotAction !== undefined)
    return !asArray(stmt.NotAction).some((p) => glob(p).test(action));
  return asArray(stmt.Action).some((p) => glob(p).test(action));
}

/**
 * Whether the statement reaches every resource of the kind an action targets.
 *
 * `*` does, and so does `arn:aws:iam::*:role/*`. A `NotResource` that carves
 * out a handful of ARNs still reaches the rest. A named or prefixed ARN does
 * not: `iam:CreateAccessKey` on `user/${aws:username}` is self-service, not
 * escalation, and flagging it would bury the findings that are.
 */
const EVERY_OF_TYPE =
  /^arn:aws[\w-]*:[\w-]+:[^:]*:[^:]*:(\*|(role|user|group|policy|instance-profile|function|instance|stack|task-definition|project|notebook-instance|devendpoint)[/:]\*)$/i;

function coversAllResources(stmt: Statement): boolean {
  if (stmt.NotResource !== undefined) return true;
  return asArray(stmt.Resource).some((r) => r === "*" || EVERY_OF_TYPE.test(r));
}

/** Condition keys whose usual values exclude nobody. */
export function conditionRestricts(condition: Record<string, unknown> | undefined): boolean {
  if (!condition) return false;
  for (const [operator, block] of Object.entries(condition)) {
    if (typeof block !== "object" || block === null) return true;
    for (const [key, raw] of Object.entries(block as Record<string, unknown>)) {
      const values = asArray(raw as string | string[]).map(String);
      const k = key.toLowerCase();
      const op = operator.toLowerCase();
      if (op.startsWith("ipaddress") && k === "aws:sourceip") {
        if (values.every((v) => v === "0.0.0.0/0" || v === "::/0")) continue;
      }
      if (op === "bool" && k === "aws:securetransport" && values.every((v) => v === "true")) {
        continue;
      }
      return true;
    }
  }
  return false;
}

interface Located {
  stmt: Statement;
  policy: PolicyRef;
}

function statements(policies: PolicyRef[]): Located[] {
  return policies.flatMap((policy) =>
    (policy.document?.Statement ?? []).map((stmt) => ({ stmt, policy })),
  );
}

/**
 * An action this principal can perform on every resource of its type: allowed
 * by an unconditional statement, denied by none, and inside the boundary.
 */
function makeOracle(policies: PolicyRef[], boundary: PolicyRef | null) {
  const all = statements(policies);
  const allows = all.filter(
    ({ stmt }) =>
      stmt.Effect === "Allow" && !conditionRestricts(stmt.Condition) && coversAllResources(stmt),
  );
  // A conditional Deny still denies in some contexts; counting it keeps a
  // positive verdict honest, which is the direction this module must not err.
  const denies = all.filter(({ stmt }) => stmt.Effect === "Deny" && coversAllResources(stmt));
  const boundaryStatements = boundary ? statements([boundary]) : null;

  return (action: string): Located | null => {
    if (denies.some(({ stmt }) => coversAction(stmt, action))) return null;
    if (
      boundaryStatements &&
      !boundaryStatements.some(
        ({ stmt }) =>
          stmt.Effect === "Allow" && coversAllResources(stmt) && coversAction(stmt, action),
      )
    ) {
      return null;
    }
    return allows.find(({ stmt }) => coversAction(stmt, action)) ?? null;
  };
}

// --- Direct grants ----------------------------------------------------------

/**
 * Actions that stand for "everything": a principal holding all of them can
 * grant itself anything else, so a `NotAction` that leaves them is admin.
 */
const ADMIN_PROBES = ["iam:PutRolePolicy", "iam:AttachUserPolicy", "iam:CreatePolicyVersion"];

function isAllActions(stmt: Statement): boolean {
  return asArray(stmt.Action).some((a) => a === "*" || a === "*:*");
}

/**
 * Does this document, on its own, grant administrator access?
 *
 * Kept for callers that ask about one document (remediation names the policy
 * to change). The principal-level answer is `evaluateAdmin`.
 */
export function documentGrantsAdmin(doc: PolicyDocument | null): { yes: boolean; sid?: string } {
  for (const stmt of doc?.Statement ?? []) {
    if (stmt.Effect !== "Allow" || conditionRestricts(stmt.Condition)) continue;
    if (!coversAllResources(stmt)) continue;
    const everything =
      isAllActions(stmt) ||
      (stmt.NotAction !== undefined && ADMIN_PROBES.every((a) => coversAction(stmt, a)));
    if (everything) return { yes: true, ...(stmt.Sid ? { sid: stmt.Sid } : {}) };
  }
  return { yes: false };
}

// --- Escalation -------------------------------------------------------------

/**
 * Known ways to turn narrower IAM permissions into administrator access.
 *
 * Each needs every listed action. Paths that need a pre-existing privileged
 * target (updating the code of a function that already runs as an admin role)
 * are left out: whether one exists is a question about other resources.
 */
export const ESCALATION_PATHS: readonly { id: string; actions: string[]; how: string }[] = [
  {
    id: "create-policy-version",
    actions: ["iam:CreatePolicyVersion"],
    how: "publish a new default version of a policy it holds",
  },
  {
    id: "set-default-policy-version",
    actions: ["iam:SetDefaultPolicyVersion"],
    how: "switch a policy it holds to a more permissive version",
  },
  {
    id: "attach-user-policy",
    actions: ["iam:AttachUserPolicy"],
    how: "attach AdministratorAccess to a user",
  },
  {
    id: "attach-group-policy",
    actions: ["iam:AttachGroupPolicy"],
    how: "attach AdministratorAccess to a group it is in",
  },
  {
    id: "attach-role-policy",
    actions: ["iam:AttachRolePolicy", "sts:AssumeRole"],
    how: "attach AdministratorAccess to a role and assume it",
  },
  {
    id: "put-user-policy",
    actions: ["iam:PutUserPolicy"],
    how: "write an inline admin policy onto a user",
  },
  {
    id: "put-group-policy",
    actions: ["iam:PutGroupPolicy"],
    how: "write an inline admin policy onto a group it is in",
  },
  {
    id: "put-role-policy",
    actions: ["iam:PutRolePolicy", "sts:AssumeRole"],
    how: "write an inline admin policy onto a role and assume it",
  },
  {
    id: "add-user-to-group",
    actions: ["iam:AddUserToGroup"],
    how: "add a user to an administrators group",
  },
  {
    id: "create-access-key",
    actions: ["iam:CreateAccessKey"],
    how: "mint access keys for another, more privileged user",
  },
  {
    id: "create-login-profile",
    actions: ["iam:CreateLoginProfile"],
    how: "set a console password on a more privileged user",
  },
  {
    id: "update-login-profile",
    actions: ["iam:UpdateLoginProfile"],
    how: "reset a more privileged user's console password",
  },
  {
    id: "update-assume-role-policy",
    actions: ["iam:UpdateAssumeRolePolicy", "sts:AssumeRole"],
    how: "rewrite an admin role's trust policy to trust itself, then assume it",
  },
  {
    id: "passrole-lambda",
    actions: ["iam:PassRole", "lambda:CreateFunction", "lambda:InvokeFunction"],
    how: "create a Lambda function running as a privileged role and invoke it",
  },
  {
    id: "passrole-ec2",
    actions: ["iam:PassRole", "ec2:RunInstances"],
    how: "launch an instance with a privileged instance profile",
  },
  {
    id: "passrole-cloudformation",
    actions: ["iam:PassRole", "cloudformation:CreateStack"],
    how: "create a stack that runs as a privileged role",
  },
  {
    id: "passrole-glue",
    actions: ["iam:PassRole", "glue:CreateDevEndpoint"],
    how: "create a Glue dev endpoint with a privileged role",
  },
  {
    id: "passrole-ecs",
    actions: ["iam:PassRole", "ecs:RegisterTaskDefinition", "ecs:RunTask"],
    how: "run an ECS task with a privileged task role",
  },
  {
    id: "passrole-codebuild",
    actions: ["iam:PassRole", "codebuild:CreateProject", "codebuild:StartBuild"],
    how: "run a CodeBuild project with a privileged service role",
  },
  {
    id: "passrole-sagemaker",
    actions: ["iam:PassRole", "sagemaker:CreateNotebookInstance"],
    how: "create a SageMaker notebook with a privileged role",
  },
];

// --- The verdict ------------------------------------------------------------

function describe(policy: PolicyRef, sid?: string): string {
  const where = sid ? `statement "${sid}" of ` : "";
  const group = policy.viaGroup ? ` of group "${policy.viaGroup}"` : "";
  return `${where}the ${policy.kind} policy "${policy.policyName}"${group}`;
}

/**
 * Decide whether a principal is effectively an administrator, given every
 * policy it holds and, when it has one, its permissions boundary.
 */
export function evaluateAdmin(
  policies: PolicyRef[],
  options: { boundary?: PolicyRef | null } = {},
): AdminVerdict {
  const boundary = options.boundary ?? null;
  const can = makeOracle(policies, boundary);
  const bounded = boundary ? `, within the permissions boundary "${boundary.policyName}"` : "";

  // Direct: every probe action allowed, and a statement that grants them all.
  if (ADMIN_PROBES.every((a) => can(a))) {
    const grant = statements(policies).find(
      ({ stmt }) =>
        stmt.Effect === "Allow" &&
        !conditionRestricts(stmt.Condition) &&
        coversAllResources(stmt) &&
        (isAllActions(stmt) ||
          (stmt.NotAction !== undefined && ADMIN_PROBES.every((a) => coversAction(stmt, a)))),
    );
    if (grant) {
      const sid = grant.stmt.Sid;
      const what =
        grant.stmt.NotAction !== undefined
          ? `every action except ${asArray(grant.stmt.NotAction).join(", ")} - which leaves IAM writable -`
          : `Action "*"`;
      return {
        isAdmin: true,
        adminVia: "direct",
        reason: `Grants ${what} on Resource "*" via ${describe(grant.policy, sid)}${bounded}`,
        via: {
          policyName: grant.policy.policyName,
          kind: grant.policy.kind,
          ...(sid ? { sid } : {}),
          ...(grant.policy.viaGroup ? { group: grant.policy.viaGroup } : {}),
        },
      };
    }
  }

  for (const path of ESCALATION_PATHS) {
    const grants = path.actions.map((a) => can(a));
    if (grants.some((g) => g === null)) continue;
    const sources = [...new Set(grants.map((g) => describe(g!.policy, g!.stmt.Sid)))];
    const first = grants[0]!;
    return {
      isAdmin: true,
      adminVia: "escalation",
      reason: `Can make itself an administrator: ${path.actions.join(" + ")} lets it ${path.how}. Granted by ${sources.join(" and ")}${bounded}`,
      via: {
        policyName: first.policy.policyName,
        kind: first.policy.kind,
        ...(first.stmt.Sid ? { sid: first.stmt.Sid } : {}),
        ...(first.policy.viaGroup ? { group: first.policy.viaGroup } : {}),
      },
      escalation: {
        id: path.id,
        actions: path.actions,
        policies: [...new Set(grants.map((g) => g!.policy.policyName))],
      },
    };
  }

  const unreadable = [...policies, ...(boundary ? [boundary] : [])].filter(
    (p) => p.document === null,
  );
  if (unreadable.length > 0) {
    return {
      isAdmin: false,
      reason: `No administrator grant or escalation path found in the readable policies, but ${unreadable.length} could not be read (${unreadable.map((p) => p.policyName).join(", ")})`,
    };
  }

  return {
    isAdmin: false,
    reason:
      policies.length === 0
        ? "No policies attached"
        : `None of the ${policies.length} policies grants administrator access or a known escalation path${bounded}`,
  };
}
