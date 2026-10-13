/**
 * The scope for one HTTP request — the single seam between "who is asking" and
 * every read below it.
 *
 * Controllers resolve it here and pass it down as a parameter; services never
 * reach for it. That is what keeps the services honest: a method that takes a
 * scope cannot read the wrong tenant's data by forgetting something, only by
 * being handed the wrong scope, and there is exactly one place that does the
 * handing.
 *
 * Hosted mode **refuses** rather than falling back to a default. A fallback is
 * indistinguishable from working: whoever configured the deployment would see
 * their own account and conclude the product was fine, and the failure would
 * surface as a customer reading somebody else's inventory.
 */

import { ServiceUnavailableException } from "@nestjs/common";

import { isHosted } from "../config.js";
import { asConnectionId } from "./ids.js";
import { localScope } from "./local.js";
import type { Scope } from "./scope.js";

/** What a request needs to carry for a scope to be derived from it. */
export interface ScopedRequest {
  /** Set by the authentication hook once there is one. */
  tenantId?: string;
  /** Which of the tenant's connections this request is about. */
  headers?: Record<string, string | string[] | undefined>;
}

export const CONNECTION_HEADER = "x-sightline-connection";

export function scopeForRequest(req: ScopedRequest): Scope {
  if (!isHosted()) {
    const scope = localScope();
    // Even self-hosted honours an explicit connection, because that is how the
    // account switcher moves between the demo fixture and a real account
    // without restarting or rewriting `.env`.
    // Not validated against the tenant's connections here: every read filters
    // on the tenant as well, so an id from elsewhere returns nothing rather
    // than somebody else's rows. The UI only ever sends ids it was given.
    const requested = headerValue(req, CONNECTION_HEADER);
    return requested ? { ...scope, connectionId: asConnectionId(requested) } : scope;
  }

  /**
   * Sign-in is still being built, so hosted mode has no way to know who is
   * asking. A refusal and not a default: there must be no window in which
   * hosted mode serves one tenant's data to an unauthenticated request, and a
   * default here is exactly such a window.
   */
  throw new ServiceUnavailableException({
    error: "Sign-in is not available in this build, so no tenant can be resolved.",
  });
}

function headerValue(req: ScopedRequest, name: string): string | undefined {
  const raw = req.headers?.[name];
  return Array.isArray(raw) ? raw[0] : raw;
}
