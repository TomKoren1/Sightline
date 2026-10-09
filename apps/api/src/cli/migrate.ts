#!/usr/bin/env tsx
/**
 * Apply any pending migrations.
 *
 * The server does this on boot as well, so this exists for the case where you
 * want the schema applied without starting anything — a fresh database, or
 * checking that a migration you just generated actually runs.
 */

import { closePool, migrate } from "../db/postgres.js";

await migrate();
console.log("Postgres migrations applied.");
await closePool();
