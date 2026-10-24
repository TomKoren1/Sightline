/**
 * Who outside this account can get in: roles other accounts may assume, and
 * resources whose policies grant other accounts.
 *
 * Each foreign account becomes an `Account` node, named by its connection when
 * it is one of this tenant's own and marked unknown when it is not - an admin
 * role assumable from an account nobody here recognises is the finding. A
 * trust that needs an ExternalId, or is limited to an organization by
 * `aws:PrincipalOrgID`, says so on the edge. Read from one scan's policies
 * alone; what the other account can do once inside is its own scan's business.
 */

import type { Relationship, Resource } from "@sightline/shared";

import { accountArn } from "../../aws/arns.js";

interface Statement {
  Effect?: string;
  Action?: string | string[];
  Principal?: string | { AWS?: string | string[] };
  Condition?: Record<string, Record<string, unknown>>;
}

const asList = <T>(v: T | T[] | undefined): T[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];

/** The account a principal belongs to, or `*` for anyone at all. */
function accountOf(principal: string): string | null {
  if (principal === "*") return "*";
  if (/^\d{12}$/.test(principal)) return principal;
  return /^arn:aws[\w-]*:(?:iam|sts)::(\d{12}):/.exec(principal)?.[1] ?? null;
}

function statementsOf(policy: unknown): Statement[] {
  const doc = typeof policy === "string" ? safeParse(policy) : policy;
  const body = (doc as { Statement?: Statement | Statement[] } | null)?.Statement;
  return body === undefined ? [] : [body].flat();
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Which condition keys narrow a grant to someone who knows a secret, or to an organization. */
function narrowing(s: Statement) {
  const keys = Object.values(s.Condition ?? {}).flatMap((block) =>
    Object.keys(block).map((k) => k.toLowerCase()),
  );
  return {
    externalId: keys.includes("sts:externalid"),
    organization: keys.includes("aws:principalorgid") || keys.includes("aws:principalorgpaths"),
  };
}

export function linkCrossAccount(
  resources: Resource[],
  ownAccountId: string,
  known: ReadonlyMap<string, string> = new Map(),
): { edges: Relationship[]; accounts: Resource[] } {
  const edges: Relationship[] = [];
  const accounts = new Map<string, Resource>();
  const nodeFor = (accountId: string) => {
    const arn = accountId === "*" ? accountArn("any") : accountArn(accountId);
    if (!accounts.has(arn)) {
      const label = known.get(accountId);
      accounts.set(arn, {
        arn,
        kind: "Account",
        name:
          accountId === "*"
            ? "Any AWS account"
            : label
              ? `${label} (${accountId})`
              : `AWS account ${accountId}, not connected to Sightline`,
        region: null,
        accountId: accountId === "*" ? "any" : accountId,
        tags: {},
        properties: { accountId, external: true, known: Boolean(label) },
        derived: {},
      });
    }
    return arn;
  };

  for (const r of resources) {
    const isRole = r.kind === "IamRole";
    const policy = isRole ? r.properties["trustPolicy"] : r.properties["policy"];
    for (const s of statementsOf(policy)) {
      if (s.Effect !== "Allow") continue;
      const actions = asList(s.Action);
      if (isRole && !actions.some((a) => ["sts:AssumeRole", "sts:*", "*"].includes(a))) continue;
      const principals = typeof s.Principal === "string" ? [s.Principal] : asList(s.Principal?.AWS);
      const { externalId, organization } = narrowing(s);
      for (const principal of principals) {
        const account = accountOf(principal);
        if (!account || account === ownAccountId) continue;
        // A resource policy open to `*` is public, which publicAccess and
        // resourcePolicy already decide; here only roles anyone can assume.
        if (account === "*" && !isRole) continue;
        const who =
          account === "*" ? "any AWS account" : (known.get(account) ?? `account ${account}`);
        const narrowed = [
          externalId ? "with an ExternalId" : "",
          organization ? "only within its organization" : "",
        ].filter(Boolean);
        edges.push({
          from: nodeFor(account),
          to: r.arn,
          type: isRole ? "CAN_ASSUME" : "CAN_ACCESS",
          properties: {
            via: isRole ? "trust policy" : "resource policy",
            principal,
            externalIdRequired: externalId,
            organizationOnly: organization,
            ...(isRole ? {} : { actions }),
            reason: isRole
              ? `${r.name} trusts ${principal}, so ${who} can assume it${narrowed.length ? ` ${narrowed.join(" and ")}` : ""}`
              : `${r.name}'s policy lets ${who} ${actions.join(", ")}${narrowed.length ? ` ${narrowed.join(" and ")}` : ""}`,
          },
        });
      }
    }
  }
  return { edges, accounts: [...accounts.values()] };
}
