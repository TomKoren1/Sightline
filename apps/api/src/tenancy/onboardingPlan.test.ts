/**
 * The onboarding plan a self-hosted clone can actually act on.
 *
 * Hosted mode publishes the role template, so the plan carries a one-click
 * link, a Terraform snippet and a URL. A clone publishes nothing - the template
 * is a file in its checkout - and the plan used to be refused outright, which
 * is what made the account menu's "Connect another account" lead nowhere.
 *
 * So the fields a published template makes possible are absent together, and
 * `cliCommand` is always there: it deploys the checkout's own copy, and is the
 * one route a clone has. Needs Postgres.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { asConnectionId, asTenantId } from "../core/ids.js";

// ExternalIds are encrypted at rest, and config is read once at import: a local
// key first, then the modules that read it.
process.env["SECRETS_LOCAL_KEY"] ??= "onboarding-plan-test-local-key";
process.env["SCANNER_PRINCIPAL_ARN"] ??= "arn:aws:iam::672299759593:user/SightlineScanner";
delete process.env["AWS_KMS_KEY_ID"];
delete process.env["DEPLOYMENT_MODE"];
delete process.env["ROLE_TEMPLATE_URL"];
const { system } = await import("../db/postgres.js");
const schema = await import("../db/schema.js");
const { createConnection } = await import("./connections.js");
const { onboardingPlan } = await import("./onboarding.js");

const HAS_INFRA = !process.env["SKIP_INTEGRATION"];
const tenantId = asTenantId(randomUUID());
let available = false;

beforeAll(async () => {
  if (!HAS_INFRA) return;
  try {
    await system.insert(schema.tenants).values({ id: tenantId, name: "onboardingPlan.test" });
    available = true;
  } catch (err) {
    console.warn("onboardingPlan.test skipped:", err);
  }
});

afterAll(async () => {
  if (available) await system.delete(schema.tenants).where(eq(schema.tenants.id, tenantId));
});

describe.runIf(HAS_INFRA)("the plan without a published template", () => {
  it("offers the CLI command and omits everything that needs a URL", async () => {
    if (!available) return;
    const created = await createConnection(tenantId, { kind: "real", label: "Second account" });
    const plan = await onboardingPlan({
      tenantId,
      connectionId: asConnectionId(created.id),
    });

    // Present, and deploying the checkout's own template.
    expect(plan.cliCommand).toContain("cloudformation/readonly-role.yaml");
    expect(plan.cliCommand).toContain(plan.externalId);

    /**
     * Absent together. A `launchUrl` built from an empty template URL is a
     * console link that opens on an error, which is worse than an option that
     * is simply not offered.
     */
    expect(plan.templateUrl).toBeUndefined();
    expect(plan.launchUrl).toBeUndefined();
    expect(plan.terraform).toBeUndefined();

    // Still enough to tell the operator what the role will be called.
    expect(plan.roleArnPattern).toContain("<your account id>");
    expect(plan.scannerPrincipalArn).toBe("arn:aws:iam::672299759593:user/SightlineScanner");
  });
});
