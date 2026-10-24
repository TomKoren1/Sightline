/**
 * What a request carries once the guard has looked at it: the session, if
 * any, and the scope it resolves to. Types only, here in core so the
 * decorators, interceptors and controllers that read them need not import
 * the guard that fills them in.
 */

import type { TeamRole } from "./access.js";
import type { TenantId } from "./ids.js";
import type { Scope } from "./scope.js";

export interface Session {
  id: string;
  userId: string;
  tenantId: TenantId;
  email: string;
  isAdmin: boolean;
  /** Their role in this tenant: `auth/roles.ts`. */
  role: TeamRole;
  expiresAt: Date;
  /** Set when the request carried an API token rather than a signed-in browser. */
  via?: "token";
  /** When this sign-in happened, for routes that want a recent one. */
  signedInAt?: Date;
}

/** What the guard has put on the request by the time a scope is wanted. */
export interface ScopedRequest {
  tenantId?: TenantId;
  scope?: Scope;
  headers?: Record<string, string | string[] | undefined>;
}

/**
 * The scope, or the reason there isn't one, decided here and raised later.
 *
 * Resolving a connection can legitimately fail - a tenant who has just signed
 * up has none yet - and that must not refuse the very routes they need to
 * create one. So the guard records the outcome and `@CurrentScope()` raises it,
 * which means the error surfaces exactly on the routes that actually wanted a
 * connection and nowhere else.
 */
export type ScopeOutcome = { ok: true; scope: Scope } | { ok: false; error: unknown };

export interface AuthedRequest extends ScopedRequest {
  method?: string;
  session?: Session | null;
  cookies?: Record<string, string | undefined>;
  scopeOutcome?: ScopeOutcome;
}
