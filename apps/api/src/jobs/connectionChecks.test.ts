/**
 * A connection check goes from the API to the worker and back.
 *
 * The AssumeRole itself is stubbed: what is under test is the hand-off, which
 * is the only thing that changed when the API stopped holding the identity.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import { system } from "../db/postgres.js";
import * as schema from "../db/schema.js";
import { asConnectionId, asTenantId } from "../core/ids.js";

const performVerification = vi.fn();
vi.mock("../tenancy/onboarding.js", () => ({
  performVerification: (...args: unknown[]): unknown => performVerification(...args),
}));

const { answerChecks, requestCheck } = await import("./connectionChecks.js");

const HAS_INFRA = !process.env["SKIP_INTEGRATION"];
const tenantId = asTenantId(randomUUID());
const connectionId = asConnectionId(randomUUID());
let available = false;

beforeAll(async () => {
  if (!HAS_INFRA) return;
  try {
    await system.insert(schema.tenants).values({ id: tenantId, name: "connectionChecks.test" });
    await system.insert(schema.connections).values({
      id: connectionId,
      tenantId,
      kind: "demo",
      label: "connectionChecks.test",
      externalIdSource: "demo",
    });
    available = true;
  } catch (err) {
    console.warn("connectionChecks.test skipped:", err);
  }
});

afterAll(async () => {
  if (available) await system.delete(schema.tenants).where(eq(schema.tenants.id, tenantId));
});

describe.runIf(HAS_INFRA)("connection checks", () => {
  it("are answered by the worker with the result of trying the role", async () => {
    if (!available) return;
    performVerification.mockResolvedValueOnce({
      ok: true,
      accountId: "123456789012",
      durationMs: 5,
    });

    const asked = requestCheck({ tenantId, connectionId });
    // Give the request a moment to land, as the worker's NOTIFY would.
    await new Promise((r) => setTimeout(r, 300));
    expect(await answerChecks("test-worker")).toBeGreaterThanOrEqual(1);

    expect(await asked).toEqual({ ok: true, accountId: "123456789012", durationMs: 5 });
    expect(performVerification).toHaveBeenCalledWith({ tenantId, connectionId });
  });

  it("turn a verification that throws into an answer, not a hung request", async () => {
    if (!available) return;
    performVerification.mockRejectedValueOnce(new Error("No such connection"));
    const asked = requestCheck({ tenantId, connectionId });
    await new Promise((r) => setTimeout(r, 300));
    await answerChecks("test-worker");
    expect(await asked).toMatchObject({ ok: false, problem: "No such connection" });
  });
});
