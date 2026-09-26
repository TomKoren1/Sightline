/**
 * Who a request is acting for.
 *
 * The design commitment, and the reason this module is tiny: **a single-tenant
 * deployment is one tenant that always exists**, rather than a special case
 * threaded through the code. Every query is tenant-scoped from the first day,
 * the self-hosted product passes the default tenant, and the hosted service
 * passes one resolved from the session.
 *
 * There is deliberately no "no tenant" path. A function that takes an optional
 * tenant is a function that will eventually be called without one, and in a
 * shared database the row it writes lands in somebody else's account
 * (ADR-017).
 */

import { isHosted } from "../config.js";

/**
 * The tenant a self-hosted deployment is.
 *
 * A fixed uuid rather than a generated one, because `schema.sql` inserts this
 * exact row and code refers to it by constant - a generated id would differ
 * between machines and make the schema non-idempotent.
 */
export const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";

/**
 * A tenant id that has been checked.
 *
 * A branded string rather than a bare one, so a plain `string` cannot be
 * passed where a tenant is required. That turns "somebody forgot to scope this
 * query" from a code review into a compile error, which is the only version of
 * that check that scales.
 */
export type TenantId = string & { readonly __tenant: unique symbol };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Accept a tenant id from outside, or refuse it.
 *
 * Every value reaching this comes from a session or a URL, so it is validated
 * rather than trusted. Refusing is a throw and not a fallback to the default:
 * falling back would turn a malformed id into a successful read of the wrong
 * tenant's data, which is the exact failure this module exists to prevent.
 */
export function asTenantId(value: unknown): TenantId {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new Error("Invalid tenant id");
  }
  return value as TenantId;
}

/**
 * The tenant for a self-hosted process.
 *
 * Throws in hosted mode, where there is no such thing - the tenant must come
 * from the request. A hosted code path that reaches for this has lost track of
 * whose data it is handling, and should fail rather than guess.
 */
export function defaultTenantId(): TenantId {
  if (isHosted()) {
    throw new Error(
      "There is no default tenant in hosted mode - the tenant must come from the request",
    );
  }
  return DEFAULT_TENANT_ID as TenantId;
}

/** The default tenant, for code that runs before or outside any request. */
export const LOCAL_TENANT = DEFAULT_TENANT_ID as TenantId;
