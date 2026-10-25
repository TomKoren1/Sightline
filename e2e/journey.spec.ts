/**
 * A customer's first visit, through the browser: sign in, scan, read the
 * findings, ask a question, and start connecting an account of their own.
 *
 * One test in steps rather than several tests, because each step needs the
 * last one's state - and a failure names the step it happened in.
 */

import { expect, test } from "@playwright/test";
import pg from "pg";

import { expectAccessible } from "./a11y.js";
import { E2E_TEAMMATE, E2E_USER, TEAMMATE_COOKIE } from "./stubs.js";
import { E2E_PORTS, e2eDatabase } from "./env.js";

const db = new pg.Pool({ connectionString: e2eDatabase().owner, max: 1 });

/** Every earlier run's tenants go, so each run starts as a first visit. */
async function forgetE2eUser(): Promise<void> {
  await db.query(
    `DELETE FROM tenants WHERE id IN (SELECT tenant_id FROM users WHERE email = ANY($1))`,
    [[E2E_USER.email, E2E_TEAMMATE.email]],
  );
}

test.beforeAll(forgetE2eUser);
test.afterAll(async () => {
  await forgetE2eUser();
  await db.end();
});

test("sign in, scan, read the findings, ask, invite, and connect", async ({ page, browser }) => {
  let invite = "";
  await test.step("signs in with GitHub", async () => {
    await page.goto("/");
    await expect(page.getByText("What Sightline can see, and what it cannot")).toBeVisible();
    await expectAccessible(page, "the sign-in page");
    await page.getByRole("link", { name: "Continue with GitHub" }).click();
    await expect(page.getByRole("button", { name: E2E_USER.email })).toBeVisible();
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
    await expectAccessible(page, "the scanned workspace");
  });

  await test.step("reads the public bucket in the findings", async () => {
    const findings = page.getByRole("complementary", { name: "Findings" });
    await findings.getByRole("button", { name: /^Exposed/ }).click();
    await expect(findings.getByText("northwind-public-assets").first()).toBeVisible();
    // Its access block neutralises the policy, so it must not be listed.
    await expect(findings.getByText("northwind-reports")).toHaveCount(0);
  });

  await test.step("finds a resource by name, and opens it", async () => {
    await page.getByLabel("Find a resource").fill("northwind-reports");
    const findings = page.getByRole("complementary", { name: "Findings" });
    await findings.getByRole("button", { name: /^northwind-reports/ }).click();
    const detail = page.getByRole("complementary", { name: "Resource" });
    await expect(detail.getByText("northwind-reports").first()).toBeVisible();
    await detail.getByRole("button", { name: "Close" }).click();
    await expect(detail).toHaveCount(0);
  });

  await test.step("asks the agent, and gets an answer from the scanned inventory", async () => {
    const chat = page.getByRole("complementary", { name: "Ask" });
    await chat.getByPlaceholder("Ask about this account…").fill("Which buckets are public?");
    await chat.getByRole("button", { name: "Ask", exact: true }).click();
    await expect(
      chat.getByText(/One bucket is public to the internet: arn:aws:s3:::northwind-public-assets/),
    ).toBeVisible({ timeout: 30_000 });
  });

  await test.step("invites a teammate with a link", async () => {
    await page.getByRole("button", { name: E2E_USER.email }).click();
    await page.getByRole("menuitem", { name: "Team" }).click();
    // Exact: the activity list below names them too.
    await expect(page.getByRole("dialog").getByText(E2E_USER.email, { exact: true })).toBeVisible();
    await expectAccessible(page, "the team panel");
    await page.getByRole("button", { name: "Create link" }).click();
    const link = page.getByText(/\?join=[\w-]{20,}/);
    await expect(link).toBeVisible();
    invite = /\S*\?join=[\w-]+/.exec((await link.textContent()) ?? "")![0];
    // The scan they ran is in the activity log.
    await expect(page.getByText("POST /api/scans").first()).toBeVisible();
    await page.getByLabel("Token name").fill("ci");
    await page.getByRole("button", { name: "Create token" }).click();
    await expect(page.getByText(/^slt_[\w-]{40,}$/)).toBeVisible();
  });

  await test.step("sets up alerts, and is told when they cannot be delivered", async () => {
    const url = page.getByLabel("Webhook URL");
    await url.fill("http://hooks.sightline.test/alerts");
    // Plain http is never sent, so it cannot even be saved.
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await url.fill("https://hooks.sightline.test/alerts");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("hooks.sightline.test", { exact: true })).toBeVisible();
    await expect(page.getByText(/nothing sent yet/)).toBeVisible();
    // A name that resolves nowhere: the test goes through the real delivery
    // path and has to come back as a failure the screen reports.
    await page.getByRole("button", { name: "Send a test" }).click();
    await expect(page.getByText(/^Test failed: /)).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Remove" }).click();
    await expect(page.getByLabel("Webhook URL")).toBeVisible();
    await page.keyboard.press("Escape");
  });

  await test.step("a teammate follows the link and lands in the workspace", async () => {
    const teammate = await browser.newContext();
    await teammate.addCookies([
      {
        name: TEAMMATE_COOKIE.split("=")[0]!,
        value: TEAMMATE_COOKIE.split("=")[1]!,
        url: `http://127.0.0.1:${E2E_PORTS.stubs}`,
      },
    ]);
    const other = await teammate.newPage();
    await other.goto(invite);
    await expect(other.getByText("You have been invited to a workspace")).toBeVisible();
    await other.getByRole("link", { name: "Continue with GitHub" }).click();
    await expect(other.getByRole("button", { name: E2E_TEAMMATE.email })).toBeVisible();
    // The owner's account, not an empty workspace of their own.
    await expect(other.getByText("demo", { exact: true }).first()).toBeVisible();
    const { rows } = await db.query<{ same: boolean }>(
      `SELECT count(DISTINCT tenant_id) = 1 AS same FROM users WHERE email = ANY($1)`,
      [[E2E_USER.email, E2E_TEAMMATE.email]],
    );
    expect(rows[0]?.same).toBe(true);
    await teammate.close();
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
