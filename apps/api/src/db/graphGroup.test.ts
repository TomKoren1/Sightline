/**
 * The graph's groups: decided in memory when a scan is written, and by SQL for
 * a scan written before - which must agree, or an old scan and a new one of
 * the same account would be browsed differently.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Relationship, Resource } from "@sightline/shared";

import { system } from "./postgres.js";
import * as schema from "./schema.js";
import { graphGroups } from "./graphGroup.js";
import { fetchGraph, graphGroups as readGroups } from "./graph.js";
import { createScanRun, saveScanResult } from "./repository.js";
import { asConnectionId, asTenantId } from "../core/ids.js";

const VPC = "arn:aws:ec2:eu-west-1:123456789012:vpc/vpc-1";
const SUBNET = "arn:aws:ec2:eu-west-1:123456789012:subnet/subnet-1";
const DB = "arn:aws:rds:eu-west-1:123456789012:db:orders";
const LAMBDA = "arn:aws:lambda:eu-west-1:123456789012:function:direct";
const BUCKET = "arn:aws:s3:::assets";

const node = (arn: string, kind: Resource["kind"]): Resource => ({
  arn,
  kind,
  name: arn.split(/[:/]/).pop()!,
  region: kind === "S3Bucket" ? null : "eu-west-1",
  accountId: "123456789012",
  tags: {},
  properties: {},
  derived: {},
});

const resources = [
  node("arn:aws:sightline:::internet", "Internet"),
  node(VPC, "Vpc"),
  node(SUBNET, "Subnet"),
  node(DB, "RdsInstance"),
  node(LAMBDA, "LambdaFunction"),
  node(BUCKET, "S3Bucket"),
];
const relationships: Relationship[] = [
  { from: SUBNET, to: VPC, type: "IN_VPC" },
  { from: DB, to: SUBNET, type: "IN_SUBNET" },
  { from: LAMBDA, to: VPC, type: "IN_VPC" },
];
const EXPECTED = {
  [VPC]: `vpc:${VPC}`,
  [SUBNET]: `vpc:${VPC}`,
  [DB]: `vpc:${VPC}`,
  [LAMBDA]: `vpc:${VPC}`,
  [BUCKET]: "kind:S3Bucket",
};

describe("graph groups", () => {
  it("puts a resource in its VPC, directly or through its subnet, and the rest by kind", () => {
    expect(Object.fromEntries(graphGroups(resources, relationships))).toEqual(EXPECTED);
  });
});

describe.runIf(!process.env["SKIP_INTEGRATION"])("graph groups, stored", () => {
  const tenantId = asTenantId(randomUUID());
  const connectionId = asConnectionId(randomUUID());
  const scope = { tenantId, connectionId };
  let available = false;

  beforeAll(async () => {
    try {
      await system.insert(schema.tenants).values({ id: tenantId, name: "graphGroup.test" });
      await system.insert(schema.connections).values({
        id: connectionId,
        tenantId,
        kind: "demo",
        label: "graphGroup.test",
        externalIdSource: "demo",
      });
      available = true;
    } catch {
      // No database: the in-memory rule above still ran.
    }
  });
  afterAll(async () => {
    if (available) await system.execute(sql`DELETE FROM tenants WHERE id = ${tenantId}`);
  });

  const stored = async (scanId: string) => {
    const { rows } = await system.execute<{ arn: string; graph_group: string | null }>(
      sql`SELECT arn, graph_group FROM resource_snapshots WHERE scan_id = ${scanId}`,
    );
    return Object.fromEntries(rows.filter((r) => r.graph_group).map((r) => [r.arn, r.graph_group]));
  };

  it("is written with the scan, and filled in by the same rule for an older one", async () => {
    if (!available) return;
    const scanId = await createScanRun(scope, "123456789012", ["eu-west-1"]);
    await saveScanResult(scope, scanId, {
      status: "succeeded",
      units: [],
      resources,
      relationships,
      apiCalls: 0,
    });
    expect(await stored(scanId)).toEqual(EXPECTED);

    // As a scan from before the column: every group unset, then one read.
    await system.execute(
      sql`UPDATE resource_snapshots SET graph_group = NULL WHERE scan_id = ${scanId}`,
    );
    const graph = { tenantId, scanId };
    const groups = await readGroups(graph);
    expect(await stored(scanId)).toEqual(EXPECTED);
    expect(groups.map((g) => [g.id, g.count])).toEqual([
      [`vpc:${VPC}`, 4],
      ["kind:S3Bucket", 1],
    ]);
    const inVpc = await fetchGraph(graph, { group: `vpc:${VPC}` });
    expect(inVpc.nodes.map((n) => n.arn).sort()).toEqual([DB, LAMBDA, SUBNET, VPC].sort());
  });
});
