/**
 * Tier 1, with nothing running: the recorded collector fixtures through the
 * real analysis, against the answer key.
 *
 * The same checks as `groundTruth.test.ts`, which seeds and scans moto and so
 * runs only where moto does. This runs in the fast CI job and on any laptop,
 * so an analyser that becomes quietly wrong fails the first job a change
 * meets rather than the slow one. Collection itself is what this cannot see;
 * `scan/collectors/contract.test.ts` holds that against moto.
 */

import { describe, expect, it } from "vitest";
import { SCANNABLE_SERVICES } from "@sightline/shared";

import { readFixture } from "../scan/collectors/fixtures.js";
import { mergeOutputs } from "../scan/collectors/types.js";
import { annotate } from "../scan/pipeline.js";
import { CHECKS, runChecks } from "./checks.js";

const fixtures = SCANNABLE_SERVICES.map((s) => readFixture(s));
const { accountId, regions } = fixtures[0]!;
const scan = annotate(accountId, regions, structuredClone(mergeOutputs(fixtures)));
const results = runChecks({ resources: scan.resources, relationships: scan.relationships });

describe("tier-1 checks over the recorded fixtures", () => {
  it.each(CHECKS.map((c) => [c.id]))("%s", (id) => {
    const result = results.find((r) => r.id === id)!;
    expect(result.passed, `${result.description}\n    found: ${result.detail}`).toBe(true);
  });
});
