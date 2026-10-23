/**
 * A finding's life across scans: opened, accepted, resolved, reopened - and not
 * resolved by a scan that did not see everything.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Resource } from "@sightline/shared";

import { system } from "./postgres.js";
import * as schema from "./schema.js";
import { listFindingStates, setFindingStatus, syncFindings } from "./findings.js";
import { asConnectionId, asTenantId } from "../tenancy/ids.js";

const HAS_INFRA = !process.env["SKIP_INTEGRATION"];

const tenantId = asTenantId(randomUUID());
const connectionId = asConnectionId(randomUUID());
const scope = { tenantId, connectionId };
let available = false;

const BUCKET = "arn:aws:s3:::lifecycle-public";
const ROLE = "arn:aws:iam::123456789012:role/lifecycle-admin";

/** A scan holding the given snapshots, each with the verdicts given. */
async function scanWith(
  rows: { arn: string; kind: Resource["kind"]; derived: Resource["derived"] }[],
) {
  const id = randomUUID();
  await system.insert(schema.scanRuns).values({
    id,
    tenantId,
    connectionId,
    accountId: "123456789012",
    status: "succeeded",
    startedAt: new Date(),
  });
  for (const row of rows) {
    await system.insert(schema.resourceSnapshots).values({
      tenantId,
      scanId: id,
      arn: row.arn,
      kind: row.kind,
      name: row.arn.split(/[:/]/).pop()!,
      region: null,
      accountId: "123456789012",
      derived: row.derived,
      fingerprint: randomUUID().replace(/-/g, ""),
    });
  }
  return id;
}

const publicBucket = {
  arn: BUCKET,
  kind: "S3Bucket" as const,
  derived: { isPublic: true, publicReason: "Its policy allows s3:GetObject to *" },
};
const adminRole = {
  arn: ROLE,
  kind: "IamRole" as const,
  derived: { isAdmin: true, adminReason: "AdministratorAccess" },
};

const byArn = async (arn: string) =>
  (await listFindingStates(scope)).find((f) => f.resourceArn === arn);

beforeAll(async () => {
  if (!HAS_INFRA) return;
  try {
    await system.insert(schema.tenants).values({ id: tenantId, name: "findings.test" });
    await system.insert(schema.connections).values({
      id: connectionId,
      tenantId,
      kind: "demo",
      label: "findings.test",
      externalIdSource: "demo",
    });
    available = true;
  } catch (err) {
    console.warn("findings.test skipped:", err);
  }
});

afterAll(async () => {
  if (available) await system.delete(schema.tenants).where(eq(schema.tenants.id, tenantId));
});

describe.runIf(HAS_INFRA)("finding lifecycle", () => {
  it("opens a finding the first time a scan sees it", async () => {
    if (!available) return;
    const result = await syncFindings(scope, await scanWith([publicBucket, adminRole]), true);
    expect(result).toEqual({ opened: 2, reopened: 0, resolved: 0 });
    expect(await byArn(BUCKET)).toMatchObject({ category: "exposed", status: "open" });
    expect(await byArn(ROLE)).toMatchObject({ category: "admin", status: "open" });
  });

  it("keeps one finding across scans rather than opening it again", async () => {
    if (!available) return;
    const first = await byArn(BUCKET);
    const result = await syncFindings(scope, await scanWith([publicBucket, adminRole]), true);
    expect(result.opened).toBe(0);
    expect((await byArn(BUCKET))?.id).toBe(first?.id);
    expect((await byArn(BUCKET))?.firstSeenAt).toBe(first?.firstSeenAt);
  });

  it("keeps an acceptance, and records who made it and why", async () => {
    if (!available) return;
    const finding = (await byArn(BUCKET))!;
    const accepted = await setFindingStatus(scope, {
      id: finding.id,
      status: "accepted",
      reason: "Hosts the public website",
      actorUserId: null,
    });
    expect(accepted).toMatchObject({
      status: "accepted",
      statusReason: "Hosts the public website",
    });

    await syncFindings(scope, await scanWith([publicBucket, adminRole]), true);
    expect((await byArn(BUCKET))?.status).toBe("accepted");

    const audit = await system
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.tenantId, tenantId), eq(schema.auditLog.subject, BUCKET)));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "finding.accepted",
      detail: { findingId: finding.id, reason: "Hosts the public website" },
    });
  });

  it("does not resolve what a partial scan did not see", async () => {
    if (!available) return;
    const result = await syncFindings(scope, await scanWith([adminRole]), false);
    expect(result.resolved).toBe(0);
    expect((await byArn(BUCKET))?.status).toBe("accepted");
  });

  it("resolves what a complete scan no longer sees", async () => {
    if (!available) return;
    const result = await syncFindings(scope, await scanWith([adminRole]), true);
    expect(result.resolved).toBe(1);
    // Resolved findings are history, not a list anyone has to work through.
    expect(await byArn(BUCKET)).toBeUndefined();
  });

  it("reopens a resolved finding that comes back, asking for the decision again", async () => {
    if (!available) return;
    const result = await syncFindings(scope, await scanWith([publicBucket, adminRole]), true);
    expect(result).toMatchObject({ opened: 0, reopened: 1 });
    expect(await byArn(BUCKET)).toMatchObject({ status: "open" });
  });

  it("refuses to change a finding that belongs to another account", async () => {
    if (!available) return;
    const finding = (await byArn(ROLE))!;
    const elsewhere = { tenantId, connectionId: asConnectionId(randomUUID()) };
    expect(
      await setFindingStatus(elsewhere, {
        id: finding.id,
        status: "accepted",
        reason: "not mine",
        actorUserId: null,
      }),
    ).toBeNull();
    expect((await byArn(ROLE))?.status).toBe("open");
  });
});
