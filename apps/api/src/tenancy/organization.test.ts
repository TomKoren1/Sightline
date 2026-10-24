/**
 * An organization's accounts become child connections - once each, with the
 * organization's ExternalId - and leave cleanly; and the listing works
 * against moto's Organizations.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  CreateAccountCommand,
  CreateOrganizationCommand,
  DescribeOrganizationCommand,
  OrganizationsClient,
} from "@aws-sdk/client-organizations";
import { readOnlyRoleArn } from "@sightline/shared";

import { asConnectionId, asTenantId } from "../core/ids.js";

// ExternalIds are encrypted at rest, and config is read once at import: a local
// key first, then the modules that read it.
process.env["SECRETS_LOCAL_KEY"] ??= "organization-test-local-key";
delete process.env["AWS_KMS_KEY_ID"];
const { cfg, MOCK_EXTERNAL_ID } = await import("../core/config.js");
const { system } = await import("../db/postgres.js");
const schema = await import("../db/schema.js");
const { createConnection, externalIdFor, listConnections } = await import("./connections.js");
const { listMemberAccounts, syncMembers } = await import("./organization.js");

const HAS_INFRA = !process.env["SKIP_INTEGRATION"];
const tenantId = asTenantId(randomUUID());
let available = false;

beforeAll(async () => {
  if (!HAS_INFRA) return;
  try {
    await system.insert(schema.tenants).values({ id: tenantId, name: "organization.test" });
    available = true;
  } catch (err) {
    console.warn("organization.test skipped:", err);
  }
});

afterAll(async () => {
  if (available) await system.delete(schema.tenants).where(eq(schema.tenants.id, tenantId));
});

const active = (id: string, name: string) => ({ id, name, state: "ACTIVE" });

describe.runIf(HAS_INFRA)("organization members", () => {
  it("become child connections once each, holding the organization's ExternalId", async () => {
    if (!available) return;
    const org = await createConnection(tenantId, { kind: "organization", label: "Northwind" });
    const scope = { tenantId, connectionId: org.id };
    const first = await syncMembers(scope, [
      active("111111111111", "prod"),
      active("222222222222", "dev"),
    ]);
    expect(first).toMatchObject({ added: 2, departed: 0 });

    const children = (await listConnections(tenantId)).filter((c) => c.parentId === org.id);
    expect(children.map((c) => c.roleArn).sort()).toEqual([
      readOnlyRoleArn("111111111111", tenantId),
      readOnlyRoleArn("222222222222", tenantId),
    ]);
    for (const c of children) {
      expect(await externalIdFor({ tenantId, connectionId: asConnectionId(c.id) })).toBe(
        org.externalId,
      );
    }

    // Again: nothing new. Then one leaves and one is suspended.
    expect(
      (await syncMembers(scope, [active("111111111111", "prod"), active("222222222222", "dev")]))
        .added,
    ).toBe(0);
    const later = await syncMembers(scope, [
      active("111111111111", "prod"),
      { id: "222222222222", name: "dev", state: "SUSPENDED" },
    ]);
    expect(later.departed).toBe(1);
    const dev = (await listConnections(tenantId)).find((c) => c.label === "dev");
    expect(dev).toMatchObject({ status: "disconnected" });
  });

  it("leaves an account already connected by hand alone", async () => {
    if (!available) return;
    const own = await createConnection(tenantId, { kind: "real", label: "mine" });
    await system
      .update(schema.connections)
      .set({ roleArn: readOnlyRoleArn("333333333333", tenantId) })
      .where(eq(schema.connections.id, own.id));
    const org = await createConnection(tenantId, { kind: "organization", label: "Other" });
    const sync = await syncMembers({ tenantId, connectionId: org.id }, [
      active("333333333333", "x"),
    ]);
    expect(sync).toMatchObject({ added: 0, alreadyConnected: ["333333333333"] });
  });

  it("lists the accounts of a real Organizations API (moto's)", async () => {
    const endpoint = cfg.AWS_ENDPOINT_URL;
    const client = new OrganizationsClient({
      region: "us-east-1",
      endpoint,
      credentials: { accessKeyId: "mock", secretAccessKey: "mock" },
    });
    try {
      await client.send(new DescribeOrganizationCommand({}));
    } catch {
      try {
        await client.send(new CreateOrganizationCommand({ FeatureSet: "ALL" }));
      } catch (err) {
        return console.warn("no Organizations in this mock:", err);
      }
      await client.send(new CreateAccountCommand({ AccountName: "member-a", Email: "a@org.test" }));
    }
    const accounts = await listMemberAccounts({
      connectionId: asConnectionId(randomUUID()),
      kind: "demo",
      roleArn: `arn:aws:iam::${process.env["MOCK_AWS_ACCOUNT_ID"] ?? "123456789012"}:role/SightlineReadOnlyRole`,
      externalId: MOCK_EXTERNAL_ID,
      endpoint,
      pinnedAccountId: null,
      regions: null,
    });
    expect(accounts.length).toBeGreaterThanOrEqual(2);
    expect(accounts.every((a) => /^\d{12}$/.test(a.id) && a.state === "ACTIVE")).toBe(true);
  });
});
