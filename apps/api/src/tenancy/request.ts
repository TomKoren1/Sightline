/**
 * The tenant a request is acting for.
 *
 * Self-hosted has exactly one, so this is a constant. Hosted reads it from
 * whatever the authentication layer attached to the request, and **throws**
 * when there is nothing there rather than falling back to the default - a
 * fallback would turn a missing session into a successful read of the default
 * tenant's data.
 *
 * Kept apart from `tenant.ts` so that module stays free of Fastify: the
 * scanner, the CLIs and the worker all need tenant ids and none of them have a
 * request.
 */

import type { FastifyRequest } from "fastify";

import { isHosted } from "../config.js";
import { asTenantId, defaultTenantId, type TenantId } from "./tenant.js";

/** What the authentication layer attaches. Declared here so both sides agree. */
export interface TenantBearingRequest {
  tenant?: unknown;
}

export class NoTenantError extends Error {
  readonly statusCode = 401;
  constructor() {
    super("Not signed in");
    this.name = "NoTenantError";
  }
}

export function tenantOf(req: FastifyRequest): TenantId {
  if (!isHosted()) return defaultTenantId();

  const attached = (req as FastifyRequest & TenantBearingRequest).tenant;
  if (attached === undefined || attached === null) throw new NoTenantError();
  return asTenantId(attached);
}
