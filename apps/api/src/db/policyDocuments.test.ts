/**
 * Policy documents are stored once and read back exactly as collected.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Resource } from "@sightline/shared";

import { system } from "./postgres.js";
import * as schema from "./schema.js";
import { documentRefs, extractDocuments, restoreDocuments } from "./policyDocuments.js";
import { createScanRun, loadResources, pruneScanHistory, saveScanResult } from "./repository.js";
import { asConnectionId, asTenantId } from "../tenancy/ids.js";

const HAS_INFRA = !process.env["SKIP_INTEGRATION"];

const ADMIN = {
  Version: "2012-10-17",
  Statement: [{ Effect: "Allow", Action: "*", Resource: "*" }],
};
const READ = {
  Version: "2012-10-17",
  Statement: [{ Effect: "Allow", Action: "s3:Get*", Resource: "*" }],
};

const role = (name: string): Resource => ({
  arn: `arn:aws:iam::123456789012:role/${name}`,
  kind: "IamRole",
  name,
  region: null,
  accountId: "123456789012",
  tags: {},
  properties: {
    roleName: name,
    attachedPolicies: [
      {
        policyName: "AdministratorAccess",
        policyArn: "arn:aws:iam::aws:policy/AdministratorAccess",
        document: ADMIN,
      },
    ],
    inlinePolicies: [{ policyName: "read", document: READ }],
    permissionsBoundary: { policyName: "boundary", document: READ },
    // Not a policy holder: only the known depth is rewritten.
    trustPolicy: { Statement: [{ Effect: "Allow", Principal: { Service: "ec2.amazonaws.com" } }] },
  },
  derived: {},
});

describe("extractDocuments", () => {
  it("replaces every document with a hash, once per distinct document", () => {
    const { properties, documents } = extractDocuments(role("app"));
    expect(documents.size).toBe(2);
    expect(JSON.stringify(properties)).not.toContain('"document"');
    expect(documentRefs(properties)).toHaveLength(3);
    expect(properties["trustPolicy"]).toEqual(role("app").properties["trustPolicy"]);
  });

  it("hashes by content, not key order", () => {
    const reordered = role("app");
    (reordered.properties["inlinePolicies"] as { document: unknown }[])[0]!.document = {
      Statement: READ.Statement,
      Version: READ.Version,
    };
    const a = documentRefs(extractDocuments(role("app")).properties);
    const b = documentRefs(extractDocuments(reordered).properties);
    expect(a).toEqual(b);
  });

  it("leaves its input, and every non-IAM resource, alone", () => {
    const input = role("app");
    const before = JSON.stringify(input);
    extractDocuments(input);
    expect(JSON.stringify(input)).toBe(before);

    const bucket = { kind: "S3Bucket" as const, properties: { document: { a: 1 } } };
    expect(extractDocuments(bucket).properties).toBe(bucket.properties);
  });

  it("round-trips through restoreDocuments", () => {
    const { properties, documents } = extractDocuments(role("app"));
    expect(restoreDocuments(properties, documents)).toEqual(role("app").properties);
  });
});

const tenantId = asTenantId(randomUUID());
const connectionId = asConnectionId(randomUUID());
const scope = { tenantId, connectionId };
let available = false;

beforeAll(async () => {
  if (!HAS_INFRA) return;
  try {
    await system.insert(schema.tenants).values({ id: tenantId, name: "policyDocuments.test" });
    await system.insert(schema.connections).values({
      id: connectionId,
      tenantId,
      kind: "demo",
      label: "policyDocuments.test",
      externalIdSource: "demo",
    });
    available = true;
  } catch (err) {
    console.warn("policyDocuments.test skipped:", err);
  }
});

afterAll(async () => {
  if (available) await system.delete(schema.tenants).where(eq(schema.tenants.id, tenantId));
});

const documentCount = async () =>
  (
    await system
      .select()
      .from(schema.policyDocuments)
      .where(eq(schema.policyDocuments.tenantId, tenantId))
  ).length;

async function scanOf(resources: Resource[]) {
  const scanId = await createScanRun(scope, "123456789012", ["us-east-1"]);
  await saveScanResult(scope, scanId, {
    status: "succeeded",
    units: [],
    resources,
    relationships: [],
    apiCalls: 0,
  });
  return scanId;
}

describe.runIf(HAS_INFRA)("stored policy documents", () => {
  it("stores a document shared by many roles once, and loads every role back whole", async () => {
    if (!available) return;
    const roles = Array.from({ length: 20 }, (_, i) => role(`r${i}`));
    const scanId = await scanOf(roles);
    expect(await documentCount()).toBe(2);

    const [stored] = await system
      .select({ properties: schema.resourceSnapshots.properties })
      .from(schema.resourceSnapshots)
      .where(eq(schema.resourceSnapshots.scanId, scanId))
      .limit(1);
    expect(JSON.stringify(stored!.properties)).not.toContain("s3:Get*");

    const loaded = await loadResources(scope, scanId);
    expect(loaded.sort((a, b) => a.name.localeCompare(b.name))[0]!.properties).toEqual(
      role("r0").properties,
    );
  });

  it("deletes documents no retained scan refers to, and keeps the rest", async () => {
    if (!available) return;
    // A later scan in which the admin policy is gone from every role.
    const reader = role("reader");
    reader.properties["attachedPolicies"] = [];
    await new Promise((r) => setTimeout(r, 20));
    await scanOf([reader]);

    await pruneScanHistory(scope, 1);
    // Prune keeps the two newest projected scans; none here is projected,
    // so only the newest survives and the admin document goes with the old one.
    expect(await documentCount()).toBe(1);
  });
});
