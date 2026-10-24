/**
 * Postgres connections, Drizzle clients, and schema migration.
 *
 * Two of each, and the difference is the whole of row-level security.
 *
 * `db` runs as a role the policies apply to, and every query through it must be
 * inside `withTenant`: escaping that context throws, and a query that forgets
 * its `WHERE tenant_id` returns nothing rather than another tenant's rows.
 *
 * `system` runs as the owner and bypasses all of it, for the few operations
 * that genuinely cannot be tenant-scoped - finding out which tenant is asking,
 * for one. Grepping for `system` is the audit.
 *
 * Two roles rather than one plus a setting because `DATABASE_URL` here is a
 * superuser, and superusers ignore RLS entirely. Two connection strings also
 * put the bypass out of reach of the request path.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate as runMigrations } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import type { Resource } from "@sightline/shared";

import { cfg } from "../core/config.js";
import { API_ROOT } from "../core/paths.js";
import * as schema from "./schema.js";

/** The setting the policies read. Also in the migration; they must agree. */
export const TENANT_SETTING = "app.tenant_id";

const poolOptions = {
  max: 10,
  // A scan writes thousands of rows; a slow query here means something is
  // wrong, and failing fast beats a request hanging forever.
  statement_timeout: 30_000,
} as const;

/**
 * The owner connection: migrations, and the few operations that cross tenants.
 *
 * Still called `pool` because the health check issues a bare `SELECT 1` through
 * it to prove the connection works, which is a liveness probe rather than a
 * query about the domain and gains nothing from the query builder.
 */
export const pool = new pg.Pool({ connectionString: cfg.DATABASE_URL, ...poolOptions });

/**
 * The restricted connection every tenant-scoped query uses.
 *
 * Falls back to `DATABASE_URL` when `DATABASE_URL_APP` is unset, which leaves
 * RLS inert because that role is a superuser. That is a deliberate convenience
 * for a clone with one tenant and no sign-in - and hosted mode refuses to start
 * without it, so the fallback cannot be how a public deployment ends up with
 * decorative policies.
 */
export const appPool = new pg.Pool({
  connectionString: cfg.DATABASE_URL_APP ?? cfg.DATABASE_URL,
  ...poolOptions,
});

/** Whether the `system` connection could change the schema: superuser, or a table owner. */
export async function connectedAsOwner(): Promise<boolean> {
  const { rows } = await pool.query<{ owner: boolean }>(
    `SELECT r.rolsuper OR EXISTS (SELECT 1 FROM pg_tables WHERE tableowner = current_user
                                     AND schemaname = 'public') AS owner
       FROM pg_roles r WHERE r.rolname = current_user`,
  );
  return rows[0]?.owner ?? false;
}

const bound = new AsyncLocalStorage<{ client: pg.PoolClient; tenantId: string }>();

/**
 * Dispatches each query to the connection bound to the current async context.
 *
 * Deliberately **not** named `...Pool`: Drizzle checks
 * `constructor.name.includes("Pool")` to decide whether to call `connect()` for
 * a transaction. Matching that would hand transactions a fresh connection with
 * no `app.tenant_id` set, so every statement inside one would see zero rows -
 * and `saveScanResult` is a transaction, so the first scan would silently
 * persist nothing.
 */
class TenantRouter {
  async query(...args: unknown[]): Promise<unknown> {
    const store = bound.getStore();
    if (!store) {
      throw new Error(
        "A tenant-scoped query ran outside `withTenant`. Every query through `db` carries " +
          `${TENANT_SETTING} on its connection, because the row-level security policies compare ` +
          "each row against it. Wrap the work in `withTenant(tenantId, ...)`, or use the " +
          "`system` handle if it genuinely cannot be scoped to one tenant - and say why.",
      );
    }
    return (store.client.query as (...a: unknown[]) => Promise<unknown>)(...args);
  }
}

/** Tenant-scoped. Requires `withTenant`; throws outside one. */
export const db = drizzle(new TenantRouter() as unknown as pg.Pool, { schema });

/**
 * Crosses tenants, as the owner. Every use needs a reason in a comment.
 *
 * The legitimate ones are all "find out who is asking" or "serve everybody": a
 * session lookup by token hash, which is how the tenant is discovered in the
 * first place; sign-in, which runs before the tenant exists; the worker's claim,
 * because one worker serves every tenant; and housekeeping.
 */
export const system = drizzle(pool, { schema });

export type Database = typeof db;

/**
 * Run `fn` with every `db` query scoped to one tenant.
 *
 * Holds one connection for the duration, set at session level: a transaction
 * per query would cost a BEGIN and COMMIT each, and one transaction per request
 * would stay open across AWS calls that take minutes.
 *
 * Nested calls reuse the outer connection - with a pool of ten and a scan
 * holding one for minutes, nesting that acquired would deadlock against itself.
 *
 * Session-scoped means the setting **must** be cleared before the connection
 * returns to the pool, so the `finally` is load-bearing. `SET LOCAL` would
 * self-clear but takes no bind parameter, which would mean interpolating a
 * tenant id into SQL.
 */
export async function withTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  const existing = bound.getStore();
  if (existing) {
    if (existing.tenantId === tenantId) return fn();
    // Two tenants in one call stack is either a bug or an attempt. Refusing is
    // the only safe answer: the inner one would otherwise run with the outer
    // one's connection setting and read the wrong account's data.
    throw new Error(
      `Refusing to run work for tenant ${tenantId} inside work already scoped to ` +
        `${existing.tenantId}. One request acts for one tenant.`,
    );
  }

  const client = await appPool.connect();
  try {
    await client.query(`SELECT set_config('${TENANT_SETTING}', $1, false)`, [tenantId]);
    return await bound.run({ client, tenantId }, fn);
  } finally {
    /**
     * Clear the setting, and destroy the connection if that fails.
     *
     * A client whose setting could not be cleared cannot safely be reused:
     * the next request to borrow it would inherit this tenant's id and read
     * their data. `release(true)` discards it instead, which costs one
     * reconnection and is the only answer that is not a leak.
     *
     * Deliberately no `return` in here. An early version had one, and a
     * `return` inside `finally` replaces whatever the `try` was returning - so
     * every successful call whose reset failed would have quietly answered
     * `undefined` instead of its result. TypeScript caught it; it would have
     * been a miserable thing to debug.
     */
    let reset = false;
    try {
      await client.query(`SELECT set_config('${TENANT_SETTING}', '', false)`);
      reset = true;
    } catch {
      // Falls through to the discarding release below.
    }
    client.release(!reset);
  }
}

/**
 * Run one statement as the tenant, read-only and on a clock.
 *
 * For the agent's SQL escape hatch: `READ ONLY` makes any write fail inside
 * Postgres whatever the guard missed, and the timeout bounds a query that is
 * merely expensive. The tenant's row-level security applies as for any read.
 */
export async function readOnlyAsTenant<T>(
  tenantId: string,
  text: string,
  values: unknown[],
  timeoutMs: number,
): Promise<T[]> {
  return withTenant(tenantId, async () => {
    const { client } = bound.getStore()!;
    await client.query("BEGIN READ ONLY");
    try {
      await client.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(timeoutMs))}`);
      const result = await client.query(text, values);
      await client.query("COMMIT");
      return result.rows as T[];
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    }
  });
}

/** The tenant the current context is scoped to, if any. For diagnostics. */
export const currentTenant = (): string | null => bound.getStore()?.tenantId ?? null;

/**
 * Apply any migrations the database has not seen.
 *
 * On boot, as the idempotent schema file it replaced did - but the schema is
 * now defined once in `schema.ts` and changes produce a reviewable migration.
 *
 * On `system`, because migrations create and alter tables: the restricted role
 * has DML only, which is the point of it.
 *
 * Found from the package root, not counted from this file: compiled, this
 * module is no longer two directories below it (paths.ts).
 */
export async function migrate(): Promise<void> {
  await runMigrations(system, { migrationsFolder: MIGRATIONS_FOLDER });
}

const MIGRATIONS_FOLDER = join(API_ROOT, "drizzle");

/**
 * Migrations this build carries that the database has not applied.
 *
 * Compared on the journal's `when` timestamp, which is the key drizzle's own
 * migrator uses to decide what to run - so this answers the same question the
 * migrator would, rather than a similar one that could disagree.
 */
export async function pendingMigrations(): Promise<string[]> {
  const journal = JSON.parse(readFileSync(`${MIGRATIONS_FOLDER}/meta/_journal.json`, "utf8")) as {
    entries: { when: number; tag: string }[];
  };

  let applied: Set<string>;
  try {
    const { rows } = await system.execute("SELECT created_at FROM drizzle.__drizzle_migrations");
    applied = new Set((rows as { created_at: string }[]).map((r) => String(r.created_at)));
  } catch {
    // No table means nothing has ever been applied, which makes every
    // migration pending - not an error to swallow quietly.
    applied = new Set();
  }

  return journal.entries.filter((e) => !applied.has(String(e.when))).map((e) => e.tag);
}

/**
 * Refuse to start against a database whose schema is behind this build.
 *
 * For the deployment where migrations run as their own Job rather than on boot.
 * Without this, a pod that started before the Job finished would serve requests
 * against an older schema: reads would fail on missing columns, and - worse -
 * a table added for row-level security would simply not be there, so nothing
 * would be policed and nothing would say so.
 *
 * Names the pending migrations and the command, because "the schema is behind"
 * is a diagnosis and not an action.
 */
export async function assertSchemaCurrent(): Promise<void> {
  const pending = await pendingMigrations();
  if (pending.length === 0) return;
  throw new Error(
    `The database is missing ${pending.length} migration(s): ${pending.join(", ")}.\n` +
      "This deployment runs migrations as a separate Job rather than on boot, so that two " +
      "replicas cannot race to apply them. Run `npm run db:migrate -w @sightline/api` (or let " +
      "the migrate Job complete) before starting the API.",
  );
}

/**
 * A stable hash of the state we care about comparing between scans.
 *
 * Deliberately excludes the raw API response: AWS returns fields that change
 * on every call without anything having actually changed, and diffing on those
 * would report noise as change.
 */
export function fingerprint(
  input: Pick<Resource, "kind" | "name" | "region" | "tags" | "properties" | "derived">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        kind: input.kind,
        name: input.name,
        region: input.region,
        tags: sortKeys(input.tags),
        properties: sortKeys(input.properties),
        derived: sortKeys(input.derived),
      }),
    )
    .digest("hex");
}

/** Key order must not affect the hash, so it is normalised recursively. */
export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

export async function closePool(): Promise<void> {
  await Promise.all([pool.end(), appPool.end()]);
}
