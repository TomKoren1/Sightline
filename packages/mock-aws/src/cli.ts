#!/usr/bin/env tsx
/** Seeds the mock AWS account. `npm run seed` from the repo root. */

import { config } from "dotenv";
import { seed } from "./seed.js";

config({ path: new URL("../../../.env", import.meta.url).pathname, quiet: true });

seed()
  .then((summary) => {
    console.log(`\nSeeded account ${summary.accountId} across ${summary.regions.join(", ")}`);
    console.log("Run `npm run scan` to ingest it.");
  })
  .catch((err) => {
    console.error("\nSeed failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
