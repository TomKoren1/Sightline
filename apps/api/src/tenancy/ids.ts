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

/**
 * One queued or running scan request.
 *
 * Distinct from `ScanId` because they exist at different times and only
 * sometimes both: a job that fails while assuming the role never produces a
 * scan, and a scan made by `npm run scan` never had a job. Both are uuids, so
 * without separate types passing one where the other belongs compiles - and
 * reads as an empty progress stream rather than as an error.
 */
export type JobId = string & { readonly __job: unique symbol };

/** One chat conversation. A uuid, and so the same trap as the others. */
export type ConversationId = string & { readonly __conversation: unique symbol };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A malformed id, as a type rather than a message.
 *
 * It needs to be recognisable at the edge, because the status code for "you
 * sent nonsense" is 400 and not 500 - and these ids arrive from path
 * parameters, query strings, headers and bodies, so recognising it per route
 * means remembering per route. `InvalidIdFilter` maps this to a 400 for every
 * route at once; a type rather than a message so the mapping cannot be broken
 * by rewording an error.
 *
 * Four routes answered 500 to a malformed id before this existed - and one of
 * them, `connections/:id/onboarding`, had the fix applied to the *header* path
 * in an earlier change while the path parameter kept throwing before the
 * handler's own try block. Which is the argument for one mechanism rather than
 * four patches.
 */
export class InvalidId extends Error {
  constructor(what: string) {
    super(`Invalid ${what}`);
    this.name = "InvalidId";
  }
}

function checked(value: unknown, what: string): string {
  // Validated rather than trusted: every value reaching these comes from a
  // session, a URL or a request body. Refusing is a throw and never a fallback
  // to some default, because a fallback turns a malformed id into a successful
  // read of the wrong tenant's data.
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new InvalidId(what);
  }
  return value;
}

export const asTenantId = (value: unknown): TenantId => checked(value, "tenant id") as TenantId;

export const asConnectionId = (value: unknown): ConnectionId =>
  checked(value, "connection id") as ConnectionId;

export const asScanId = (value: unknown): ScanId => checked(value, "scan id") as ScanId;

export const asJobId = (value: unknown): JobId => checked(value, "scan job id") as JobId;

export const asConversationId = (value: unknown): ConversationId =>
  checked(value, "conversation id") as ConversationId;
