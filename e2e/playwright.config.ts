/**
 * The browser suite: the hosted product, driven the way a customer drives it.
 *
 * Needs the compose stack's Postgres and moto running and the mock account
 * seeded; `e2e/stack.ts` starts everything else. Run with
 * `npm run e2e` (`npx playwright install chromium` once, first).
 */

import { defineConfig, devices } from "@playwright/test";

import { E2E_BASE_URL } from "./env.js";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  // One journey through one tenant: its steps depend on each other.
  fullyParallel: false,
  workers: 1,
  retries: process.env["CI"] ? 1 : 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: process.env["CI"]
    ? [["list"], ["html", { open: "never", outputFolder: "../test-results/e2e-report" }]]
    : "list",
  outputDir: "../test-results/e2e",
  use: {
    baseURL: E2E_BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npx tsx e2e/stack.ts",
    cwd: "..",
    url: `${E2E_BASE_URL}/api/health`,
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
  },
});
