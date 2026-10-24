/**
 * Whose data, and which of their accounts.
 *
 * Passed explicitly rather than read from ambient state, for the reason
 * ambient state is wrong here: a value that is correct when there is one of
 * something is silently wrong when there are many. Making it a parameter turns
 * "did anyone forget?" into a build error.
 *
 * Both halves are needed. The tenant is the security boundary - it is what
 * every row is filtered on and what row-level security enforces. The
 * connection says which of that tenant's AWS accounts is being read, and
 * conflating the two is how a scan of staging gets recorded against
 * production.
 */

import type { ConnectionId, TenantId } from "./ids.js";

export interface Scope {
  tenantId: TenantId;
  connectionId: ConnectionId;
}
