/**
 * Who a request acts for, and which of their AWS accounts it reads.
 *
 * Branded strings rather than bare ones, so a plain `string` cannot be passed
 * where a tenant or a connection is required. That turns "did somebody forget
 * to scope this query?" from a code review into a compile error, which is the
 * only version of that check that scales.
 *
 * There is deliberately no "no tenant" path. A function taking an optional
 * tenant is one that will eventually be called without one, and in a shared
 * database the row it writes lands in somebody else's account.
 */

/** A tenant id that has been validated. */
export type TenantId = string & { readonly __tenant: unique symbol };

/**
 * One connected AWS account, belonging to one tenant.
 *
 * Separate from `TenantId` because a tenant has several: the tenant is who is
 * asking, the connection is which account they are asking about. Conflating
 * them is how a scan of staging gets recorded against production.
 */
export type ConnectionId = string & { readonly __connection: unique symbol };

/**
 * One scan, and the graph projected from it.
 *
 * Node identity in Neo4j is `(scanId, arn)`, so this is also the graph's scope
 * - see `db/neo4j.ts` for why the projection is keyed on the scan rather than
 * on the connection.
 */
export type ScanId = string & { readonly __scan: unique symbol };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function checked(value: unknown, what: string): string {
  // Validated rather than trusted: every value reaching these comes from a
  // session, a URL or a request body. Refusing is a throw and never a fallback
  // to some default, because a fallback turns a malformed id into a successful
  // read of the wrong tenant's data.
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new Error(`Invalid ${what}`);
  }
  return value;
}

export const asTenantId = (value: unknown): TenantId => checked(value, "tenant id") as TenantId;

export const asConnectionId = (value: unknown): ConnectionId =>
  checked(value, "connection id") as ConnectionId;

export const asScanId = (value: unknown): ScanId => checked(value, "scan id") as ScanId;
