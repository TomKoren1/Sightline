#!/usr/bin/env tsx
/** Apply the Postgres schema. Idempotent; safe to run on every boot. */

import { closePool, migrate } from "../db/postgres.js";

await migrate();
console.log("Postgres schema applied.");
await closePool();
