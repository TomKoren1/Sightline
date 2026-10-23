/**
 * The system gauges refresh from Postgres without throwing. Requires Postgres.
 */

import { describe, expect, it } from "vitest";

import { refreshConnections, refreshQueueDepth } from "./snapshot.js";

const HAS_INFRA = !process.env["SKIP_INTEGRATION"];

describe.runIf(HAS_INFRA)("the system gauges", () => {
  it("reports queue depth and connection counts without throwing", async () => {
    // Shape, not value: other tests are creating and draining jobs
    // concurrently, so any assertion about the number would be a race.
    await expect(refreshQueueDepth()).resolves.toBeUndefined();
    await expect(refreshConnections()).resolves.toBeUndefined();
  });
});
