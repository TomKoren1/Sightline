/**
 * drizzle-kit configuration.
 *
 * Lives in this workspace rather than at the repository root because the schema
 * and the database client do: drizzle-kit resolves `drizzle-orm` from where it
 * runs, and from the root it cannot see a dependency of `@daveio/api`.
 *
 * `DATABASE_URL` is read straight from the environment rather than through the
 * app's config module, because drizzle-kit is its own process and importing
 * that module would pull in the AWS SDK and Zod validation to emit a
 * `CREATE TABLE`. The default matches the one in `config.ts`.
 */
import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";
import { fileURLToPath } from "node:url";

config({ path: fileURLToPath(new URL("../../.env", import.meta.url)), quiet: true });

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env["DATABASE_URL"] ?? "postgres://dave:dave@localhost:5432/dave",
  },
});
