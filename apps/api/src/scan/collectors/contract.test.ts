/**
 * Each collector does what its registry entry says, against moto: emits only
 * the kinds and relationship types it declares, stays inside its call budget,
 * and still produces the shape its committed fixture records.
 *
 * The fixture check is by shape, because moto mints new ids on every seed. A
 * failure there means the collector or the seed changed: re-record with
 * `npm run gen:fixtures`.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { seed } from "@sightline/mock-aws";
import { SCANNABLE_SERVICES } from "@sightline/shared";

import { cfg, isMock, MOCK_EXTERNAL_ID } from "../../config.js";
import { asConnectionId } from "../../tenancy/ids.js";
import { collectEstate, type CollectedEstate } from "../runner.js";
import { readFixture, shapeOf, toFixture } from "./fixtures.js";
import { COLLECTORS } from "./registry.js";

const HAS_INFRA = !process.env["SKIP_INTEGRATION"];
let estate: CollectedEstate | null = null;

beforeAll(async () => {
  if (!HAS_INFRA || !isMock()) return;
  const target = {
    connectionId: asConnectionId("00000000-0000-0000-0000-00000000c0c0"),
    kind: "demo" as const,
    roleArn: `arn:aws:iam::${process.env["MOCK_AWS_ACCOUNT_ID"] ?? "123456789012"}:role/SightlineReadOnlyRole`,
    externalId: MOCK_EXTERNAL_ID,
    endpoint: cfg.AWS_ENDPOINT_URL,
    pinnedAccountId: null,
    regions: null,
  };
  try {
    // Always from a fresh seed: the ground-truth suite's drift check leaves
    // the account changed, and the fixtures record it as seeded.
    await seed();
    estate = await collectEstate({ target, scanId: "contract" });
  } catch (err) {
    console.warn("contract.test skipped:", err);
  }
}, 300_000);

describe.runIf(HAS_INFRA)("every collector keeps to its registry entry", () => {
  it.each(SCANNABLE_SERVICES.map((s) => [s]))("%s", (service) => {
    if (!estate) return;
    const plugin = COLLECTORS[service];
    const units = estate.unitOutputs.filter((u) => u.unit.service === service);
    expect(units.length, `${service} produced no unit`).toBeGreaterThan(0);

    for (const { unit, output } of units) {
      const where = `${service}/${unit.region ?? "global"}`;
      const kinds = [...new Set(output.resources.map((r) => r.kind))];
      expect(
        kinds.filter((k) => !plugin.kinds.includes(k)),
        `${where} emits undeclared kinds`,
      ).toEqual([]);
      const types = [...new Set(output.relationships.map((r) => r.type))];
      expect(
        types.filter((t) => !plugin.relationships.includes(t)),
        `${where} emits undeclared relationship types`,
      ).toEqual([]);
      const budget = plugin.calls.perUnit + plugin.calls.perResource * output.resources.length;
      expect(
        unit.apiCalls,
        `${where} made ${unit.apiCalls} calls, budget ${budget}`,
      ).toBeLessThanOrEqual(Math.ceil(budget));
    }

    const live = toFixture(
      units.map((u) => u.output),
      estate.accountId,
      estate.regions,
    );
    expect(shapeOf(live), `the ${service} fixture is stale; re-record it`).toEqual(
      shapeOf(readFixture(service)),
    );
  });
});
