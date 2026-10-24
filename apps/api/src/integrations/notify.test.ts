import { describe, expect, it, vi } from "vitest";

import { describeNew } from "./notify.js";

const account = { label: "Production", accountId: "123456789012" };

describe("the new-findings message", () => {
  it("says what is new and where, listing a few", () => {
    const text = describeNew(account, [
      { category: "exposed", name: "public-assets", kind: "S3Bucket" },
      { category: "admin", name: "LegacyDeployRole", kind: "IamRole" },
      { category: "idle", name: "old-volume", kind: "EbsVolume" },
    ])!;
    expect(text).toMatch(
      /^Sightline: Production \(123456789012\) has 1 exposed to the internet and 1 with admin access/,
    );
    expect(text).toContain("• public-assets (S3Bucket) - exposed");
    expect(text).not.toContain("old-volume");
  });

  it("stays quiet when nothing urgent is new", () => {
    expect(describeNew(account, [{ category: "idle", name: "v", kind: "EbsVolume" }])).toBeNull();
    expect(describeNew(account, [])).toBeNull();
  });

  it("lists five and counts the rest", () => {
    const fresh = Array.from({ length: 8 }, (_, i) => ({
      category: "exposed" as const,
      name: `b${i}`,
      kind: "S3Bucket",
    }));
    expect(describeNew(account, fresh)).toContain("and 3 more");
  });
});

describe.runIf(!process.env["SKIP_INTEGRATION"])("the stored webhook", () => {
  it("keeps the URL encrypted and shows only its host", async () => {
    // A local key, read when config loads, so the modules are loaded afresh.
    process.env["SECRETS_LOCAL_KEY"] = "a-long-random-string-for-tests";
    delete process.env["AWS_KMS_KEY_ID"];
    vi.resetModules();
    const { randomUUID } = await import("node:crypto");
    const { sql } = await import("drizzle-orm");
    const { system } = await import("../db/postgres.js");
    const { asTenantId } = await import("../core/ids.js");
    const { deleteWebhook, getWebhook, setWebhook, WebhookRefused } = await import("./notify.js");
    const tenantId = asTenantId(randomUUID());
    try {
      await system.execute(sql`INSERT INTO tenants (id, name) VALUES (${tenantId}, 'notify.test')`);
    } catch {
      return;
    }
    try {
      const url = "https://hooks.slack.com/services/T000/B000/secret-part";
      await setWebhook(tenantId, url, null);
      expect(await getWebhook(tenantId)).toMatchObject({
        configured: true,
        host: "hooks.slack.com",
      });
      const { rows } = await system.execute<{ c: Buffer }>(
        sql`SELECT url_ciphertext AS c FROM webhooks WHERE tenant_id = ${tenantId}`,
      );
      expect(rows[0]!.c.toString("utf8")).not.toContain("secret-part");
      await expect(setWebhook(tenantId, "https://10.0.0.5/hook", null)).rejects.toBeInstanceOf(
        WebhookRefused,
      );
      await deleteWebhook(tenantId);
      expect((await getWebhook(tenantId)).configured).toBe(false);
    } finally {
      await system.execute(sql`DELETE FROM tenants WHERE id = ${tenantId}`);
    }
  });
});
