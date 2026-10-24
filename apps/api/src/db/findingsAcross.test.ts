import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { findingsAcrossAccounts } from "./findings.js";
import { system } from "./postgres.js";
import * as schema from "./schema.js";
import { asTenantId } from "../tenancy/ids.js";

const HAS_INFRA = !process.env["SKIP_INTEGRATION"];
const tenantId = asTenantId(randomUUID());
const otherTenant = asTenantId(randomUUID());
const prod = randomUUID();
const dev = randomUUID();
const theirs = randomUUID();
let available = false;

beforeAll(async () => {
  if (!HAS_INFRA) return;
  try {
    for (const id of [tenantId, otherTenant]) {
      await system.insert(schema.tenants).values({ id, name: "findingsAcross.test" });
    }
    for (const [id, tenant, label] of [
      [prod, tenantId, "Production"],
      [dev, tenantId, "Development"],
      [theirs, otherTenant, "Someone else"],
    ] as const) {
      await system.insert(schema.connections).values({
        id,
        tenantId: tenant,
        kind: "demo",
        label,
        externalIdSource: "demo",
      });
    }
    const finding = (
      connectionId: string,
      tenant: string,
      category: schema.FindingCategory,
      name: string,
      status: "open" | "accepted" = "open",
    ) => ({
      id: randomUUID(),
      tenantId: tenant,
      connectionId,
      category,
      resourceArn: `arn:aws:s3:::${name}`,
      resourceName: name,
      resourceKind: "S3Bucket",
      status,
    });
    await system
      .insert(schema.findings)
      .values([
        finding(prod, tenantId, "idle", "prod-idle"),
        finding(prod, tenantId, "exposed", "prod-public"),
        finding(dev, tenantId, "admin", "dev-admin"),
        finding(dev, tenantId, "exposed", "dev-accepted", "accepted"),
        finding(theirs, otherTenant, "exposed", "their-public"),
      ]);
    available = true;
  } catch (err) {
    console.warn("findingsAcross.test skipped:", err);
  }
});

afterAll(async () => {
  if (!available) return;
  for (const id of [tenantId, otherTenant]) {
    await system.delete(schema.tenants).where(eq(schema.tenants.id, id));
  }
});

describe.runIf(HAS_INFRA)("findings across accounts", () => {
  it("counts each account's open findings by category", async () => {
    if (!available) return;
    const { accounts } = await findingsAcrossAccounts(tenantId, { limit: 50 });
    const byLabel = Object.fromEntries(accounts.map((a) => [a.label, a.open]));
    expect(Object.keys(byLabel).sort()).toEqual(["Development", "Production"]);
    expect(byLabel["Production"]).toMatchObject({ exposed: 1, idle: 1, admin: 0 });
    expect(byLabel["Development"]).toMatchObject({ exposed: 0, admin: 1 });
  });

  it("lists open findings worst first, never another tenant's or an accepted one", async () => {
    if (!available) return;
    const { findings } = await findingsAcrossAccounts(tenantId, { limit: 50 });
    expect(findings.map((f) => f.name)).toEqual(["prod-public", "dev-admin", "prod-idle"]);
  });

  it("filters to one category", async () => {
    if (!available) return;
    const { findings } = await findingsAcrossAccounts(tenantId, { category: "admin", limit: 50 });
    expect(findings.map((f) => f.name)).toEqual(["dev-admin"]);
  });
});
