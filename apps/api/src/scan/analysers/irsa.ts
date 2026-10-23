/**
 * Which IAM roles a cluster's pods can assume, through IRSA.
 *
 * A role is assumable from a pod when its trust policy names the cluster's OIDC
 * provider as a federated principal for `sts:AssumeRoleWithWebIdentity`. Which
 * pods is the `<issuer>:sub` condition: `system:serviceaccount:<ns>:<name>`,
 * possibly with wildcards. No `sub` condition at all means every service
 * account in the cluster - any pod - which is the misconfiguration worth
 * naming. The two halves come from different collectors (EKS is regional, IAM
 * global), so this runs once both have.
 */

import type { Relationship, Resource } from "@sightline/shared";

interface Statement {
  Effect?: string;
  Action?: string | string[];
  Principal?: { Federated?: string | string[] } | string;
  Condition?: Record<string, Record<string, string | string[]>>;
}

const asList = (v: string | string[] | undefined) =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];

const allowsWebIdentity = (s: Statement) =>
  s.Effect === "Allow" &&
  asList(s.Action).some((a) => ["sts:AssumeRoleWithWebIdentity", "sts:*", "*"].includes(a));

/** The service accounts a statement admits for this provider, or `*` for all of them. */
function serviceAccounts(s: Statement, provider: string): string[] {
  const subs = Object.entries(s.Condition ?? {})
    .filter(([op]) =>
      /^String(Equals|Like)(IgnoreCase)?$/.test(op.replace(/^ForAnyValue:|^ForAllValues:/, "")),
    )
    .flatMap(([, keys]) => asList(keys[`${provider}:sub`]));
  if (subs.length === 0) return ["*"];
  return subs.map((sub) => sub.replace(/^system:serviceaccount:/, "").replace(":", "/"));
}

export function linkIrsa(resources: Resource[]): Relationship[] {
  const clusters = resources.flatMap((r) => {
    const issuer = r.kind === "EksCluster" ? r.properties["oidcIssuer"] : null;
    return typeof issuer === "string"
      ? [{ cluster: r, provider: issuer.replace(/^https:\/\//, "") }]
      : [];
  });
  if (clusters.length === 0) return [];

  const edges: Relationship[] = [];
  for (const role of resources) {
    if (role.kind !== "IamRole") continue;
    const policy = role.properties["trustPolicy"] as { Statement?: Statement | Statement[] } | null;
    const statements = policy?.Statement === undefined ? [] : [policy.Statement].flat();
    for (const { cluster, provider } of clusters) {
      const admitted = statements
        .filter(allowsWebIdentity)
        .filter(
          (s) =>
            typeof s.Principal === "object" &&
            asList(s.Principal.Federated).some((f) => f.endsWith(`:oidc-provider/${provider}`)),
        )
        .flatMap((s) => serviceAccounts(s, provider));
      if (admitted.length === 0) continue;
      const any = admitted.includes("*");
      edges.push({
        from: cluster.arn,
        to: role.arn,
        type: "CAN_ASSUME",
        properties: {
          via: "IRSA",
          serviceAccounts: any ? ["*"] : [...new Set(admitted)],
          reason: any
            ? `${role.name} trusts ${cluster.name}'s OIDC provider with no service account condition, so any pod in the cluster can assume it`
            : `Pods running as ${[...new Set(admitted)].join(", ")} in ${cluster.name} can assume ${role.name} through IRSA`,
        },
      });
    }
  }
  return edges;
}
