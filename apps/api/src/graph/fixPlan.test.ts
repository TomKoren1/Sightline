/** The fix plan: every open finding's computed fixes, less those someone accepted as a risk. */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Resource } from "@sightline/shared";

import { system } from "../db/postgres.js";
import * as schema from "../db/schema.js";
import { createScanRun, markProjected, saveScanResult } from "../db/repository.js";
import { listFindingStates, setFindingStatus, syncFindings } from "../db/findings.js";
import { asConnectionId, asTenantId } from "../core/ids.js";
import { GraphService } from "./graph.service.js";

const tenantId = asTenantId(randomUUID());
const connectionId = asConnectionId(randomUUID());
const scope = { tenantId, connectionId };
let available = false;

const bucket = (name: string, isPublic: boolean): Resource => ({
  arn: `arn:aws:s3:::${name}`,
  kind: "S3Bucket",
  name,
  region: "us-east-1",
  accountId: "123456789012",
  tags: {},
  properties: { publicAccessBlock: null, policy: null, aclGrants: [] },
  derived: isPublic ? { isPublic: true, publicReason: "Its policy allows *" } : {},
});

beforeAll(async () => {
  if (process.env["SKIP_INTEGRATION"]) return;
  try {
    await system.insert(schema.tenants).values({ id: tenantId, name: "fixPlan.test" });
    await system.insert(schema.connections).values({
      id: connectionId,
      tenantId,
      kind: "demo",
      label: "fixPlan.test",
      externalIdSource: "demo",
    });
    const scanId = await createScanRun(scope, "123456789012", ["us-east-1"]);
    await saveScanResult(scope, scanId, {
      status: "succeeded",
      units: [],
      resources: [bucket("public-assets", true), bucket("private-logs", false)],
      relationships: [],
      apiCalls: 0,
    });
    await syncFindings(scope, scanId, true);
    await markProjected(scope, scanId);
    available = true;
  } catch (err) {
    console.warn("fixPlan.test skipped:", err);
  }
});

afterAll(async () => {
  if (available) await system.execute(sql`DELETE FROM tenants WHERE id = ${tenantId}`);
});

describe.runIf(!process.env["SKIP_INTEGRATION"])("the fix plan", () => {
  it("holds the flagged resources' fixes and nothing for the clean ones", async () => {
    if (!available) return;
    const plan = await new GraphService().fixPlan(scope);
    expect(plan.accountId).toBeNull(); // a demo connection pins no account
    const names = new Set(plan.items.map((i) => i.name));
    expect(names).toEqual(new Set(["public-assets"]));
    expect(plan.items.map((i) => i.remediation.id)).toContain("s3-enable-block-public-access");
  });

  it("drops a fix once its finding is accepted as a risk", async () => {
    if (!available) return;
    const [finding] = await listFindingStates(scope);
    await setFindingStatus(scope, {
      id: finding!.id,
      status: "accepted",
      reason: "serves the public site",
      actorUserId: null,
    });
    const plan = await new GraphService().fixPlan(scope);
    expect(plan.items.filter((i) => i.remediation.addresses === "public")).toEqual([]);
  });
});
