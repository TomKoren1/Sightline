/**
 * The curated query library.
 *
 * Every question the agent can ask the graph is answered by one of these,
 * written by hand and reviewed (ADR-005). The model chooses which to call and
 * with what arguments; it does not write the Cypher.
 *
 * Each function returns rows that always carry an `arn`, because ARNs are what
 * the agent is permitted to cite and what the UI highlights in the graph. If a
 * query cannot return ARNs, it does not belong here.
 */

import neo4j from "neo4j-driver";
import { INTERNET_ARN } from "@daveio/shared";
import { readQuery } from "./neo4j.js";

/** Cap every query, so one bad question cannot drag the whole estate back. */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/**
 * Bound a caller-supplied limit and hand it to the driver as a Neo4j integer.
 *
 * `LIMIT` requires an INTEGER. A plain JS number crosses the wire as a float
 * and Neo4j rejects it with "found 100.0", so the conversion is done here
 * rather than remembered at fifteen call sites.
 */
const clamp = (n: number | undefined, fallback = DEFAULT_LIMIT) =>
  neo4j.int(Math.min(Math.max(1, Math.floor(n ?? fallback)), MAX_LIMIT));

export interface ResourceRow {
  arn: string;
  kind: string;
  name: string;
  region: string | null;
  [key: string]: unknown;
}

export async function listResources(params: {
  kind?: string;
  region?: string;
  nameContains?: string;
  limit?: number;
}): Promise<ResourceRow[]> {
  return readQuery<ResourceRow>(
    `MATCH (r:Resource)
     WHERE ($kind   IS NULL OR r.kind = $kind)
       AND ($region IS NULL OR r.region = $region)
       AND ($name   IS NULL OR toLower(r.name) CONTAINS toLower($name))
       AND r.kind <> 'Internet'
     RETURN r.arn AS arn, r.kind AS kind, r.name AS name, r.region AS region,
            r.isPublic AS isPublic, r.isAdmin AS isAdmin, r.isIdle AS isIdle
     ORDER BY r.kind, r.name
     LIMIT $limit`,
    {
      kind: params.kind ?? null,
      region: params.region ?? null,
      name: params.nameContains ?? null,
      limit: clamp(params.limit),
    },
  );
}

/** Everything known about one resource, plus its immediate neighbours. */
export async function getResource(arnOrName: string): Promise<ResourceRow | null> {
  const rows = await readQuery<ResourceRow>(
    `MATCH (r:Resource)
     WHERE r.arn = $key OR r.name = $key
     OPTIONAL MATCH (r)-[out]->(o:Resource)
     OPTIONAL MATCH (i:Resource)-[in]->(r)
     RETURN properties(r) AS props, r.arn AS arn, r.kind AS kind, r.name AS name,
            r.region AS region,
            collect(DISTINCT {type: type(out), arn: o.arn, name: o.name, kind: o.kind}) AS outgoing,
            collect(DISTINCT {type: type(in),  arn: i.arn, name: i.name, kind: i.kind}) AS incoming
     LIMIT 1`,
    { key: arnOrName },
  );
  return rows[0] ?? null;
}

/**
 * Resources an anonymous caller can reach.
 *
 * `isPublic` was decided during ingest by analysers that can be unit tested,
 * and `publicReason` records the evidence. The agent reads both; it does not
 * re-derive the verdict.
 */
export async function findPublicResources(params: { kind?: string; limit?: number } = {}) {
  return readQuery<ResourceRow>(
    `MATCH (r:Resource)
     WHERE r.isPublic = true AND ($kind IS NULL OR r.kind = $kind)
     RETURN r.arn AS arn, r.kind AS kind, r.name AS name, r.region AS region,
            r.publicReason AS reason
     ORDER BY r.kind, r.name
     LIMIT $limit`,
    { kind: params.kind ?? null, limit: clamp(params.limit) },
  );
}

/**
 * Principals with effective administrator access, and what uses them.
 *
 * "What uses them" is the half that makes the answer actionable: an admin role
 * attached to a running instance is an incident, and an admin role nothing
 * references is cleanup.
 */
export async function findAdminPrincipals(params: { limit?: number } = {}) {
  return readQuery<ResourceRow>(
    `MATCH (r:Resource:IamRole)
     WHERE r.isAdmin = true
     OPTIONAL MATCH (p:InstanceProfile)-[:PROVIDES_ROLE]->(r)
     OPTIONAL MATCH (i:Ec2Instance)-[:HAS_INSTANCE_PROFILE]->(p)
     OPTIONAL MATCH (f:LambdaFunction)-[:EXECUTES_AS]->(r)
     WITH r,
          collect(DISTINCT {arn: i.arn, name: i.name, kind: 'Ec2Instance'}) AS instances,
          collect(DISTINCT {arn: f.arn, name: f.name, kind: 'LambdaFunction'}) AS functions
     RETURN r.arn AS arn, 'IamRole' AS kind, r.name AS name, null AS region,
            r.adminReason AS reason,
            [u IN instances + functions WHERE u.arn IS NOT NULL] AS usedBy,
            size([u IN instances + functions WHERE u.arn IS NOT NULL]) AS useCount
     ORDER BY useCount DESC, r.name
     LIMIT $limit`,
    { limit: clamp(params.limit) },
  );
}

/**
 * Every path by which one resource can be reached from another.
 *
 * The default source is the internet, which is what "what can reach X?" almost
 * always means. Paths are capped in length because an uncapped
 * variable-length match over a dense security group graph is how you hang a
 * Neo4j instance.
 */
export async function findNetworkPaths(params: {
  target: string;
  source?: string;
  maxHops?: number;
  limit?: number;
}) {
  const maxHops = Math.min(Math.max(1, params.maxHops ?? 5), 8);
  return readQuery<{
    hops: Array<{ arn: string; name: string; kind: string }>;
    edges: Array<{ ports: string[]; reason: string; via: string }>;
    length: number;
  }>(
    // The hop bound is interpolated because Cypher does not allow a parameter
    // inside a variable-length pattern. It is clamped to 1..8 immediately
    // above and never reaches here as user text.
    `MATCH (target:Resource)
     WHERE target.arn = $target OR target.name = $target
     MATCH (source:Resource)
     WHERE source.arn = $source OR source.name = $source
     MATCH path = (source)-[:CAN_REACH*1..${maxHops}]->(target)
     WITH [n IN nodes(path) | {arn: n.arn, name: n.name, kind: n.kind}] AS hops,
          [r IN relationships(path) | {ports: r.ports, reason: r.reason, via: r.via}] AS edges,
          length(path) AS length
     // One route opened on several ports is one route. Collapsing them keeps
     // the answer about paths rather than about port numbers, and stops a
     // security group with five rules from looking like five separate ways in.
     WITH hops, length, collect(edges) AS variants
     RETURN hops, length,
            [i IN range(0, length - 1) | {
              via: variants[0][i].via,
              reason: variants[0][i].reason,
              ports: reduce(acc = [], v IN variants |
                       CASE WHEN v[i].ports IN acc THEN acc ELSE acc + v[i].ports END)
            }] AS edges
     ORDER BY length ASC
     LIMIT $limit`,
    {
      target: params.target,
      source: params.source ?? INTERNET_ARN,
      limit: clamp(params.limit, 25),
    },
  );
}

/** What a resource can reach, rather than what can reach it. */
export async function findReachableFrom(params: {
  source: string;
  maxHops?: number;
  limit?: number;
}) {
  const maxHops = Math.min(Math.max(1, params.maxHops ?? 3), 8);
  return readQuery<ResourceRow>(
    `MATCH (source:Resource)
     WHERE source.arn = $source OR source.name = $source
     MATCH path = (source)-[:CAN_REACH*1..${maxHops}]->(t:Resource)
     WITH t, min(length(path)) AS hops
     RETURN t.arn AS arn, t.kind AS kind, t.name AS name, t.region AS region, hops
     ORDER BY hops, t.name
     LIMIT $limit`,
    { source: params.source, limit: clamp(params.limit) },
  );
}

/**
 * Instances outside a private subnet.
 *
 * Both halves are reported: instances in a subnet that routes to an internet
 * gateway, and instances in no subnet at all - the second is rarer and easier
 * to miss, which is exactly why it is worth returning.
 */
export async function findInstancesInPublicSubnets(params: { limit?: number } = {}) {
  return readQuery<ResourceRow>(
    `MATCH (i:Resource:Ec2Instance)
     OPTIONAL MATCH (i)-[:IN_SUBNET]->(s:Subnet)
     WITH i, s
     WHERE s IS NULL OR s.isPublic = true
     RETURN i.arn AS arn, 'Ec2Instance' AS kind, i.name AS name, i.region AS region,
            i.state AS state,
            coalesce(s.name, '(none)') AS subnet,
            CASE WHEN s IS NULL
                 THEN 'Instance is not associated with any subnet'
                 ELSE s.publicReason END AS reason
     ORDER BY i.name
     LIMIT $limit`,
    { limit: clamp(params.limit) },
  );
}

/** Billable and doing nothing, most expensive first. */
export async function findIdleResources(params: { limit?: number } = {}) {
  return readQuery<ResourceRow>(
    `MATCH (r:Resource)
     WHERE r.isIdle = true
     RETURN r.arn AS arn, r.kind AS kind, r.name AS name, r.region AS region,
            r.idleReason AS reason,
            coalesce(r.estimatedMonthlyCostUsd, 0) AS estimatedMonthlyCostUsd
     ORDER BY estimatedMonthlyCostUsd DESC, r.name
     LIMIT $limit`,
    { limit: clamp(params.limit) },
  );
}

/** Security groups exposing a port to the whole internet. */
export async function findOpenSecurityGroups(params: { limit?: number } = {}) {
  return readQuery<ResourceRow>(
    `MATCH (internet:Internet)-[e:CAN_REACH]->(r:Resource)
     RETURN DISTINCT r.arn AS arn, r.kind AS kind, r.name AS name, r.region AS region,
            collect(DISTINCT e.ports) AS ports,
            head(collect(e.via)) AS securityGroup,
            head(collect(e.reason)) AS reason
     ORDER BY r.name
     LIMIT $limit`,
    { limit: clamp(params.limit) },
  );
}

/** Free-text search across resource names and tags. */
export async function searchResources(params: { text: string; limit?: number }) {
  return readQuery<ResourceRow>(
    `MATCH (r:Resource)
     WHERE toLower(r.name) CONTAINS toLower($text)
        OR toLower(coalesce(r.tagsJson, '')) CONTAINS toLower($text)
        OR toLower(r.arn) CONTAINS toLower($text)
     RETURN r.arn AS arn, r.kind AS kind, r.name AS name, r.region AS region
     ORDER BY r.kind, r.name
     LIMIT $limit`,
    { text: params.text, limit: clamp(params.limit, 25) },
  );
}

/** Counts by kind and region - cheap orientation for an opening question. */
export async function summariseAccount() {
  const [byKind, byRegion, flags] = await Promise.all([
    readQuery<{ kind: string; count: number }>(
      `MATCH (r:Resource) WHERE r.kind <> 'Internet'
       RETURN r.kind AS kind, count(*) AS count ORDER BY count DESC`,
    ),
    readQuery<{ region: string; count: number }>(
      `MATCH (r:Resource) WHERE r.region IS NOT NULL
       RETURN r.region AS region, count(*) AS count ORDER BY count DESC`,
    ),
    readQuery<{ publicCount: number; adminCount: number; idleCount: number; idleCost: number }>(
      `MATCH (r:Resource)
       RETURN count(CASE WHEN r.isPublic = true THEN 1 END) AS publicCount,
              count(CASE WHEN r.isAdmin  = true THEN 1 END) AS adminCount,
              count(CASE WHEN r.isIdle   = true THEN 1 END) AS idleCount,
              sum(CASE WHEN r.isIdle = true
                       THEN coalesce(r.estimatedMonthlyCostUsd, 0) ELSE 0 END) AS idleCost`,
    ),
  ]);
  return { byKind, byRegion, ...(flags[0] ?? {}) };
}

/** The whole graph, for the frontend to lay out. */
export async function fetchGraph(
  params: { region?: string; kinds?: string[]; limit?: number } = {},
) {
  const nodes = await readQuery<ResourceRow>(
    `MATCH (r:Resource)
     WHERE ($region IS NULL OR r.region = $region OR r.region IS NULL)
       AND ($kinds  IS NULL OR r.kind IN $kinds)
     RETURN r.arn AS arn, r.kind AS kind, r.name AS name, r.region AS region,
            r.isPublic AS isPublic, r.isAdmin AS isAdmin, r.isIdle AS isIdle,
            r.estimatedMonthlyCostUsd AS estimatedMonthlyCostUsd,
            coalesce(r.publicReason, r.adminReason, r.idleReason) AS reason
     LIMIT $limit`,
    { region: params.region ?? null, kinds: params.kinds ?? null, limit: clamp(params.limit, 500) },
  );

  const arns = new Set(nodes.map((n) => n.arn));
  const edges = await readQuery<{ from: string; to: string; type: string; ports: string | null }>(
    `MATCH (a:Resource)-[r]->(b:Resource)
     WHERE a.arn IN $arns AND b.arn IN $arns
     RETURN a.arn AS from, b.arn AS to, type(r) AS type, r.ports AS ports
     LIMIT 2000`,
    { arns: [...arns] },
  );

  return { nodes, edges };
}
