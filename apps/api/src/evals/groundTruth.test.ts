/**
 * Tier 1 of the eval suite: ground truth over the ingested data, needing no
 * model and no API key. If these fail, no prompt work will make the agent right.
 *
 * Seeds the mock, runs a genuine scan, and applies the checks in `checks.ts` -
 * the same definitions the Trust panel runs, so the suite and the product cannot
 * disagree about what "correct" means. Their expectations come from the
 * hand-written answer key in `topology.ts`, so an analyser bug cannot grade
 * itself as correct.
 *
 * Requires the compose stack; skipped when moto is unreachable.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DRIFT_EXPECTED_CHECK_FAILURES, drift, seed } from "@sightline/mock-aws";
import type { Relationship, Resource } from "@sightline/shared";

import { isMock } from "../config.js";
import { runScan } from "../scan/runner.js";
import { CHECKS, runChecks, type CheckResult } from "./checks.js";
import { errorMessage } from "@sightline/shared";

let resources: Resource[] = [];
let relationships: Relationship[] = [];
let results: CheckResult[] = [];
let available = false;
let skipReason: string | null = null;

beforeAll(async () => {
  try {
    /**
     * Refuse to run unless we are pointed at the mock.
     *
     * This suite seeds a fixture and then runs a real scan. With `.env` in
     * `real` mode that scan goes to an actual AWS account - so the assertions
     * fail confusingly, and, far worse, running the test suite makes live API
     * calls against somebody's infrastructure.
     *
     * A test run must never touch a real cloud account, however read-only the
     * calls are. Checked before anything else happens.
     */
    if (!isMock()) {
      skipReason =
        "AWS_MODE is not 'mock'. This suite seeds a fixture and scans it, so it refuses " +
        "to run against a real account. Set AWS_MODE=mock to exercise it.";
      return;
    }

    const endpoint = process.env["AWS_ENDPOINT_URL"] ?? "http://localhost:5000";
    const res = await fetch(`${endpoint}/moto-api/`).catch(() => null);
    if (!res?.ok) {
      skipReason = `moto was not reachable at ${endpoint}. Start it with \`docker compose up -d\`.`;
      return;
    }

    await seed();
    const scan = await runScan({ scanId: "eval" });
    resources = scan.resources;
    relationships = scan.relationships;
    results = runChecks({ resources, relationships });
    available = true;
  } catch (err) {
    console.warn("Ground-truth suite skipped:", errorMessage(err));
  }
}, 180_000);

afterAll(() => {
  if (!available && skipReason) {
    console.warn(`\n  Ground-truth suite did not run.\n  ${skipReason}\n`);
  }
});

describe.runIf(!process.env["SKIP_INTEGRATION"])("ingest ground truth", () => {
  it("collects a non-trivial inventory", () => {
    if (!available) return;
    expect(skipReason, "suite ran, so there should be no skip reason").toBeNull();
    expect(resources.length).toBeGreaterThan(50);
    expect(relationships.length).toBeGreaterThan(50);
  });

  // One test per check, so a failure names the property that broke rather than
  // reporting that "ground truth failed".
  it.each(CHECKS.map((c) => [c.id, c.description] as const))("%s: %s", (id) => {
    if (!available) return;
    const result = results.find((r) => r.id === id);
    expect(result, `check ${id} did not run`).toBeDefined();
    expect(result!.passed, `${result!.description}\n    found: ${result!.detail}`).toBe(true);
  });

  it("runs every check that is defined", () => {
    if (!available) return;
    expect(results).toHaveLength(CHECKS.length);
  });
});

/**
 * Drift must break exactly the checks it claims to break.
 *
 * The Trust panel excuses a failing check when its id is in
 * `DRIFT_EXPECTED_CHECK_FAILURES`. A mutation without an entry makes a *correct*
 * detection read as a defect; an entry left behind is worse, because the panel
 * then excuses a genuine regression.
 *
 * Lives in this file so it cannot run concurrently with the pristine checks
 * above - vitest parallelises across files, and one suite seeding while another
 * drifts the same moto instance makes both flaky. Re-seeds afterwards.
 */
describe.runIf(!process.env["SKIP_INTEGRATION"])("drift attribution", () => {
  it("breaks exactly the checks declared as expected, and no others", async () => {
    if (!available) return;

    try {
      await drift();
      const drifted = await runScan({ scanId: "eval-drift" });
      const after = runChecks({
        resources: drifted.resources,
        relationships: drifted.relationships,
      });

      const failed = after
        .filter((r) => !r.passed)
        .map((r) => r.id)
        .sort();
      const declared = Object.keys(DRIFT_EXPECTED_CHECK_FAILURES).sort();

      // Both directions, with the detail in the message: a bare set
      // comparison tells you it broke, not which way.
      const undeclared = failed.filter((id) => !declared.includes(id));
      const missing = declared.filter((id) => !failed.includes(id));

      expect(
        undeclared,
        "these checks failed after drift but are not declared as expected, so the Trust " +
          "panel will report them as unexplained failures. Either drift gained a mutation " +
          "that needs an entry in DRIFT_EXPECTED_CHECK_FAILURES, or an analyser regressed.\n" +
          after
            .filter((r) => undeclared.includes(r.id))
            .map((r) => `      ${r.id}: ${r.detail}`)
            .join("\n"),
      ).toEqual([]);

      expect(
        missing,
        "these checks are declared as expected to fail after drift but passed, so the " +
          "panel would excuse a real regression in them. Remove the entry, or restore the " +
          "mutation that used to cause it.",
      ).toEqual([]);

      expect(failed).toEqual(declared);
    } finally {
      // Leave the account as it was found, whatever happened above.
      await seed();
    }
  }, 240_000);
});
