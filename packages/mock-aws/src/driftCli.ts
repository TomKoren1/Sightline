#!/usr/bin/env tsx
/**
 * Apply drift to the already-seeded mock account, so a second scan has
 * something meaningful to diff against the first.
 *
 *   npm run seed && npm run scan && npm run drift && npm run scan
 */

import { config } from "dotenv";
import { drift } from "./drift.js";
import { waitForMoto } from "./clients.js";

config({ path: new URL("../../../.env", import.meta.url).pathname, quiet: true });

console.log("Applying drift to the mock account...");
await waitForMoto();
await drift();
console.log("\nDone. Run `npm run scan` again to see the changes.");
