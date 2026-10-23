/**
 * A customer's first visit, through the browser: sign in, scan, read the
 * findings, ask a question, and start connecting an account of their own.
 *
 * One test in steps rather than several tests, because each step needs the
 * last one's state - and a failure names the step it happened in.
 */

import { expect, test } from "@playwright/test";
import pg from "pg";

import { E2E_USER } from "./stubs.js";
import { e2eDatabase } from "./env.js";

const db = new pg.Pool({ connectionString: e2eDatabase().owner, max: 1 });

/** Every earlier run's tenant goes, so each run starts as a first visit. */
async function forgetE2eUser(): Promise<void> {
  await db.query(`DELETE FROM tenants WHERE id IN (SELECT tenant_id FROM users WHERE email = $1)`, [
    E2E_USER.email,
  ]);
}

test.beforeAll(forgetE2eUser);
test.afterAll(async () => {
  await forgetE2eUser();
  await db.end();
});

test("sign in, scan, read the findings, ask, and connect", async ({ page }) => {
  await test.step("signs in with GitHub", async () => {
    await page.goto("/");
    await expect(page.getByText("What Sightline can see, and what it cannot")).toBeVisible();
    await page.getByRole("link", { name: "Continue with GitHub" }).click();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    await expect(page.getByText("No inventory yet")).toBeVisible();
  });

  await test.step("gets the demo account", async () => {
    // The demo fixture is an operator's facility, gated on the tenant's admin
    // flag, so there is no button for it - an operator grants it.
    await db.query(
      `UPDATE tenants SET is_admin = true
        WHERE id = (SELECT tenant_id FROM users WHERE email = $1)`,
      [E2E_USER.email],
    );
    const created = await page.request.post("/api/connections", {
      headers: { "X-Sightline-Request": "1" },
      data: { label: "Demo", kind: "demo" },
    });
    expect(created.status(), await created.text()).toBe(201);
    await page.reload();
    await expect(page.getByText("demo", { exact: true }).first()).toBeVisible();
  });

  await test.step("scans it, through the worker", async () => {
    await page.getByRole("button", { name: "Run the first scan" }).click();
    await expect(page.getByRole("button", { name: "Rescan" })).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText(/\d+ resources across 3 regions/)).toBeVisible();
  });

  await test.step("reads the public bucket in the findings", async () => {
    const findings = page.getByRole("complementary", { name: "Findings" });
    await findings.getByRole("button", { name: /^Exposed/ }).click();
    await expect(findings.getByText("northwind-public-assets").first()).toBeVisible();
    // Its access block neutralises the policy, so it must not be listed.
    await expect(findings.getByText("northwind-reports")).toHaveCount(0);
  });

  await test.step("asks the agent, and gets an answer from the scanned inventory", async () => {
    const chat = page.getByRole("complementary", { name: "Ask" });
    await chat.getByPlaceholder("Ask about this account…").fill("Which buckets are public?");
    await chat.getByRole("button", { name: "Ask", exact: true }).click();
    await expect(
      chat.getByText(/One bucket is public to the internet: arn:aws:s3:::northwind-public-assets/),
    ).toBeVisible({ timeout: 30_000 });
  });

  await test.step("starts connecting an account of their own", async () => {
    await page.getByRole("button", { name: "Connection" }).click();
    await page.getByPlaceholder("Production").fill("Production");
    await page.getByRole("button", { name: "Continue" }).click();
    // The plan carries an ExternalId, minted and encrypted under KMS.
    await expect(page.getByText("What this grants, and the ExternalId")).toBeVisible();
    await page.getByPlaceholder("123456789012").fill("210987654321");
    await page.getByRole("button", { name: "Check connection" }).click();
    // No such role exists, so the check must fail - with the worker's answer
    // about the role, not the API's "the worker did not answer".
    const problem = page.locator("p.text-warn").last();
    await expect(problem).toBeVisible({ timeout: 40_000 });
    await expect(problem).not.toContainText("did not answer");
    await expect(page.locator("form p.text-danger")).toHaveCount(0);
    const { rows } = await db.query<{ answered: number }>(
      `SELECT count(*)::int AS answered FROM connection_checks c
         JOIN users u ON u.tenant_id = c.tenant_id
        WHERE u.email = $1 AND c.status = 'done' AND c.locked_by IS NOT NULL`,
      [E2E_USER.email],
    );
    expect(rows[0]?.answered).toBeGreaterThan(0);
  });
});
