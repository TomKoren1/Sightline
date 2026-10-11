#!/usr/bin/env tsx
/** Seeds the mock AWS account. `npm run seed` from the repo root. */

import { fileURLToPath } from "node:url";

import { config } from "dotenv";
import { seed } from "./seed.js";
import { errorMessage } from "@sightline/shared";

// fileURLToPath, not URL.pathname: the latter is a URL path and cannot address
// the filesystem on Windows or through any directory needing escaping. See
// apps/api/src/config.ts and engineering log #36.
config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)), quiet: true });

seed()
  .then((summary) => {
    console.log(`\nSeeded account ${summary.accountId} across ${summary.regions.join(", ")}`);
    console.log("Run `npm run scan` to ingest it.");
  })
  .catch((err) => {
    console.error("\nSeed failed:", errorMessage(err));
    process.exitCode = 1;
  });
