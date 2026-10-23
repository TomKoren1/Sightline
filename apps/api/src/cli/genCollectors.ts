/**
 * Regenerate what the collector registry decides: the role template's grant
 * and the collectors' reference page. See `scan/collectors/generated.ts`.
 *
 * With `--fixtures`, also record each collector's output from the seeded mock
 * into `scan/collectors/fixtures/` (see `fixtures.ts`). Refuses unless pointed
 * at the mock, for the same reason the ground-truth suite does.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCANNABLE_SERVICES } from "@sightline/shared";

import { cfg, isMock, MOCK_EXTERNAL_ID } from "../config.js";
import { toFixture, writeFixture } from "../scan/collectors/fixtures.js";
import { renderCollectorDocs, withTemplateBlock } from "../scan/collectors/generated.js";
import { COLLECTORS } from "../scan/collectors/registry.js";
import { collectEstate } from "../scan/runner.js";
import { asConnectionId } from "../tenancy/ids.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const template = `${root}infra/readonly-role.yaml`;
const docs = `${root}apps/api/src/scan/collectors/README.md`;

writeFileSync(template, withTemplateBlock(readFileSync(template, "utf8"), COLLECTORS));
writeFileSync(docs, renderCollectorDocs(COLLECTORS));
console.log(`Wrote ${template}\nWrote ${docs}`);

if (process.argv.includes("--fixtures")) {
  if (!isMock())
    throw new Error("Fixtures are recorded from the mock only; AWS_MODE is not 'mock'.");
  const estate = await collectEstate({
    scanId: "fixtures",
    target: {
      connectionId: asConnectionId("00000000-0000-0000-0000-00000000f1f0"),
      kind: "demo",
      roleArn: `arn:aws:iam::${process.env["MOCK_AWS_ACCOUNT_ID"] ?? "123456789012"}:role/SightlineReadOnlyRole`,
      externalId: MOCK_EXTERNAL_ID,
      endpoint: cfg.AWS_ENDPOINT_URL,
      pinnedAccountId: null,
      regions: null,
    },
  });
  const failed = estate.units.filter((u) => u.status !== "succeeded");
  if (failed.length > 0) {
    throw new Error(`Not recording a partial estate: ${failed.map((u) => u.error).join("; ")}`);
  }
  for (const service of SCANNABLE_SERVICES) {
    const outputs = estate.unitOutputs
      .filter((u) => u.unit.service === service)
      .map((u) => u.output);
    writeFixture(service, toFixture(outputs, estate.accountId, estate.regions));
  }
  console.log(`Recorded ${SCANNABLE_SERVICES.length} fixtures from ${cfg.AWS_ENDPOINT_URL}`);
}
