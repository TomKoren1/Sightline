#!/usr/bin/env tsx
/**
 * Apply pending migrations without starting the server, which also does this on
 * boot. For a fresh database, or checking that a generated migration runs.
 */

import { closePool, migrate } from "../db/postgres.js";

await migrate();
console.log("Postgres migrations applied.");
await closePool();
