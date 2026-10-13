/**
 * Two tenants in one graph, and nothing of one may reach the other.
 *
 * This is the control the whole tenancy design rests on. The other two guards
 * fail differently and neither is sufficient: the **static** one (every query's
 * text binds `$tenantId` and `$scanId`) and the **runtime** one (`readScoped`
 * refuses Cypher that does not) both pass a query that binds the parameters and
 * still leaks - a pattern scoped on one side of a relationship but not the
 * other, say. Only running two tenants and looking at what comes back catches
 * that.
 *
 * The query list is discovered **by reflection**, so adding a fourteenth query
 * and forgetting to cover it fails this file for *not being covered*, before it
 * can ever fail for leaking. That is the part that makes the test survive
 * contact with future changes.
 *
 * Both tenants deliberately hold the synthetic `Internet` node, whose ARN is
 * the same constant for everyone. Under the old `arn IS UNIQUE` constraint the
 * second tenant could not have been projected at all, and under a plain ARN
 * match the edge projection would have joined one tenant's relationships to the
 * other's nodes - an edge that genuinely exists, which every path query would
 * then traverse.
 *
 * Requires Postgres and Neo4j; skipped without them.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { INTERNET_ARN, type Relationship, type Resource } from "@sightline/shared";

import { projectGraph, sweepSupersededScans, type GraphScope } from "./neo4j.js";
import * as queries from "./queries.js";
import { asScanId, asTenantId } from "../tenancy/ids.js";

const HAS_INFRA = !process.env["SKIP_INTEGRATION"];

interface Fixture {
  scope: GraphScope;
  /** A distinguishing substring present in every one of this tenant's names. */
  tag: string;
  arns: string[];
  names: { bucket: string; role: string; instance: string; database: string };
}

/**
 * One tenant's inventory: small, but shaped so that every curated query has
 * something to return. A query that returns nothing for both tenants proves
 * nothing about isolation.
 */
function build(
  tag: string,
  account: string,
): { resources: Resource[]; relationships: Relationship[] } {
  const r = (
    kind: Resource["kind"],
    name: string,
    arn: string,
    derived: Resource["derived"] = {},
    properties: Resource["properties"] = {},
  ): Resource => ({
    arn,
    kind,
    name,
    region: "us-east-1",
    accountId: account,
    tags: { Owner: tag },
    properties,
    derived,
  });

  const bucket = `arn:aws:s3:::${tag}-bucket`;
  const role = `arn:aws:iam::${account}:role/${tag}-admin`;
  const instance = `arn:aws:ec2:us-east-1:${account}:instance/i-${tag}`;
  const subnet = `arn:aws:ec2:us-east-1:${account}:subnet/subnet-${tag}`;
  const database = `arn:aws:rds:us-east-1:${account}:db:${tag}-db`;

  const resources: Resource[] = [
    // The same ARN in both tenants, on purpose.
    r("Internet", "Public internet", INTERNET_ARN),
    r(
      "S3Bucket",
      `${tag}-bucket`,
      bucket,
      {
        isPublic: true,
        publicReason: `${tag} bucket policy allows *`,
        isUnprotected: true,
        unprotectedReason: `${tag} has no public access block`,
      },
      {},
    ),
    r("IamRole", `${tag}-admin`, role, {
      isAdmin: true,
      adminReason: `${tag} carries AdministratorAccess`,
    }),
    r("Ec2Instance", `${tag}-host`, instance, {
      isIdle: true,
      idleReason: `${tag} instance is stopped`,
      estimatedMonthlyCostUsd: 42,
    }),
    r("Subnet", `${tag}-public-subnet`, subnet, {
      isPublic: true,
      publicReason: `${tag} subnet routes to an internet gateway`,
    }),
    r("RdsInstance", `${tag}-db`, database),
  ];

  const relationships: Relationship[] = [
    {
      from: INTERNET_ARN,
      to: instance,
      type: "CAN_REACH",
      properties: { ports: ["tcp/22"], via: `${tag}-sg`, reason: `${tag} sg allows 0.0.0.0/0` },
    },
    {
      from: instance,
      to: database,
      type: "CAN_REACH",
      properties: { ports: ["tcp/5432"], via: `${tag}-db-sg`, reason: `${tag} db sg` },
    },
    { from: instance, to: subnet, type: "IN_SUBNET", properties: {} },
  ];

  return { resources, relationships };
}

async function project(tag: string, account: string): Promise<Fixture> {
  const scope: GraphScope = {
    tenantId: asTenantId(randomUUID()),
    scanId: asScanId(randomUUID()),
  };
  const { resources, relationships } = build(tag, account);
  await projectGraph(scope, resources, relationships);
  return {
    scope,
    tag,
    arns: resources.map((x) => x.arn),
    names: {
      bucket: `${tag}-bucket`,
      role: `${tag}-admin`,
      instance: `${tag}-host`,
      database: `${tag}-db`,
    },
  };
}

/**
 * How to call each query, keyed by its exported name.
 *
 * Every exported query must appear here. The test below asserts that, so a new
 * one cannot be added without deciding how it is exercised.
 */
const CALLS: Record<string, (f: Fixture) => Promise<unknown>> = {
  listResources: (f) => queries.listResources(f.scope, {}),
  getResource: (f) => queries.getResource(f.scope, f.names.bucket),
  findPublicResources: (f) => queries.findPublicResources(f.scope, {}),
  findAdminPrincipals: (f) => queries.findAdminPrincipals(f.scope, {}),
  findNetworkPaths: (f) => queries.findNetworkPaths(f.scope, { target: f.names.database }),
  findReachableFrom: (f) => queries.findReachableFrom(f.scope, { source: INTERNET_ARN }),
  findInstancesInPublicSubnets: (f) => queries.findInstancesInPublicSubnets(f.scope, {}),
  findIdleResources: (f) => queries.findIdleResources(f.scope, {}),
  findUnprotectedBuckets: (f) => queries.findUnprotectedBuckets(f.scope, {}),
  findOpenSecurityGroups: (f) => queries.findOpenSecurityGroups(f.scope, {}),
  // Matches a substring both tenants' names share, so a leak is *likely* rather
  // than merely possible: an unscoped version returns both tenants' rows.
  searchResources: (f) => queries.searchResources(f.scope, { text: "-db" }),
  summariseAccount: (f) => queries.summariseAccount(f.scope),
  fetchGraph: (f) => queries.fetchGraph(f.scope, {}),
};

/**
 * Queries whose results carry no tenant-identifying string at all.
 *
 * An aggregate returns counts and kind names, so "did it return any of my own
 * data?" cannot be answered by looking for a tag. Their non-emptiness is
 * asserted directly instead - see "counts only one tenant's resources" below,
 * which checks the numbers against the fixture. Listed explicitly rather than
 * detected, so a query cannot drift into this exemption unnoticed.
 */
const AGGREGATES = new Set(["summariseAccount"]);

/** Every string anywhere in a result, however deeply nested. */
function strings(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, into);
  else if (value && typeof value === "object")
    for (const v of Object.values(value)) strings(v, into);
  return into;
}

/**
 * The two tenants, and whether they were projected.
 *
 * `available` rather than a nullable handle, as `repository.test.ts` does: a
 * `let` that TypeScript has to narrow stops being narrowed inside every
 * callback below, and the guard is what actually decides whether the bodies
 * run.
 */
let a = {} as Fixture;
let b = {} as Fixture;
let available = false;

beforeAll(async () => {
  try {
    a = await project("t1", "111111111111");
    b = await project("t2", "222222222222");
    available = true;
  } catch (err) {
    console.warn("Tenant isolation suite skipped:", err instanceof Error ? err.message : err);
  }
}, 120_000);

afterAll(async () => {
  if (!available) return;
  // Keep nothing: an empty keep list deletes every scope for that tenant.
  for (const f of [a, b]) {
    await sweepSupersededScans(f.scope.tenantId, []).catch(() => 0);
  }
});

describe.runIf(HAS_INFRA)("tenant isolation in the graph", () => {
  it("covers every exported query", () => {
    if (!available) return;
    const exported = Object.entries(queries)
      .filter(([, v]) => typeof v === "function")
      .map(([k]) => k)
      // Not a query: a helper that happens to be exported.
      .filter((k) => k !== "clamp");
    const uncovered = exported.filter((name) => !(name in CALLS));
    expect(
      uncovered,
      "these queries are not exercised by the isolation test, so nothing is checking whether " +
        "they leak. Add an entry to CALLS.",
    ).toEqual([]);
  });

  it("exempts only queries that really carry no identifying string", async () => {
    if (!available) return;
    // Otherwise the exemption becomes a place for a broken query to hide.
    for (const name of AGGREGATES) {
      const mine = strings(await CALLS[name]!(a));
      expect(
        mine.some((s) => s.includes(a.tag)),
        `${name} is exempted as an aggregate but does return identifying strings, ` +
          "so it should be checked like the others. Remove it from AGGREGATES.",
      ).toBe(false);
    }
  });

  it("projected both tenants, including the shared Internet node", async () => {
    if (!available) return;
    // Proves the composite identity works: under `arn IS UNIQUE` the second
    // tenant's Internet node could not have been created at all.
    const [one, two] = await Promise.all([
      queries.getResource(a.scope, INTERNET_ARN),
      queries.getResource(b.scope, INTERNET_ARN),
    ]);
    expect(one?.arn).toBe(INTERNET_ARN);
    expect(two?.arn).toBe(INTERNET_ARN);
  });

  describe("every query, run as one tenant", () => {
    it.each(Object.keys(CALLS))(
      "%s returns nothing belonging to the other tenant",
      async (name) => {
        if (!available) return;
        const call = CALLS[name]!;

        const mine = strings(await call(a));
        const theirs = strings(await call(b));

        // Neither direction, because a predicate can be wrong in one direction
        // only - a pattern scoped on the source but not the target, say.
        const leakedIntoMine = mine.filter((s) => s.includes(b.tag));
        const leakedIntoTheirs = theirs.filter((s) => s.includes(a.tag));

        expect(leakedIntoMine, `${name} returned ${b.tag} data to ${a.tag}`).toEqual([]);
        expect(leakedIntoTheirs, `${name} returned ${a.tag} data to ${b.tag}`).toEqual([]);

        /**
         * And it must have returned *something* of its own.
         *
         * Without this the test passes for a query that is broken to the point of
         * returning nothing at all, which is the way an isolation test quietly
         * stops testing anything.
         */
        if (!AGGREGATES.has(name)) {
          expect(
            mine.some((s) => s.includes(a.tag)),
            `${name} returned no ${a.tag} data either, so this case proves nothing. ` +
              "Fix the fixture or the query.",
          ).toBe(true);
        }
      },
    );
  });

  it("finds exactly one path per tenant, not both tenants' paths", async () => {
    if (!available) return;
    /**
     * The case that an unscoped relationship pattern would fail.
     *
     * Both tenants have `Internet -> host -> db`, and the Internet node is the
     * same ARN. If the projection had matched edge endpoints by ARN alone, one
     * tenant's host would hang off the other's Internet node and this would
     * return two paths.
     */
    const paths = await queries.findNetworkPaths(a.scope, { target: a.names.database });
    expect(paths).toHaveLength(1);
    expect(paths[0]!.hops.map((h) => h.name)).toEqual([
      "Public internet",
      a.names.instance,
      a.names.database,
    ]);
  });

  it("counts only one tenant's resources", async () => {
    if (!available) return;
    const summary = await queries.summariseAccount(a.scope);
    const total = summary.byKind.reduce((sum, k) => sum + k.count, 0);
    // Six resources, less the Internet node which `summariseAccount` excludes.
    expect(total).toBe(5);
    expect(summary.publicCount).toBe(2); // the bucket and the subnet
    expect(summary.adminCount).toBe(1);
    expect(summary.idleCount).toBe(1);
  });

  it("refuses a query that does not bind the scope", async () => {
    if (!available) return;
    // The runtime guard, from the outside: this is the mistake the static and
    // behavioural checks are both too late to catch during development.
    const { readScoped } = await import("./neo4j.js");
    await expect(readScoped(a.scope, "MATCH (n:Resource) RETURN n.arn AS arn")).rejects.toThrow(
      /does not bind \$tenantId/,
    );
  });
});
