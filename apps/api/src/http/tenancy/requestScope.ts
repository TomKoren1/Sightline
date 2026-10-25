/**
 * The scope for one request — the single seam between "who is asking" and every
 * read below it.
 *
 * Resolved once, in the authentication guard, and attached to the request;
 * controllers read it with `@CurrentScope()` and pass it down as a parameter.
 * Services never reach for it. That is what keeps them honest: a method taking
 * a scope cannot read the wrong tenant's data by forgetting something, only by
 * being handed the wrong scope, and there is exactly one place that hands it
 * over.
 *
 * Hosted mode **refuses** rather than falling back to a default tenant. A
 * fallback is indistinguishable from working: whoever configured the deployment
 * would see their own account and conclude the product was fine, while a
 * customer read somebody else's inventory.
 */

import { BadRequestException, ConflictException } from "@nestjs/common";
import { and, asc, eq, ne } from "drizzle-orm";

import { isHosted } from "../../core/config.js";
import { db, withTenant } from "../../db/postgres.js";
import { connections } from "../../db/schema.js";
import { asConnectionId, asTenantId, type ConnectionId, type TenantId } from "../../core/ids.js";
import { localScope } from "../../tenancy/local.js";
import type { Scope } from "../../core/scope.js";
import { requestsWithoutConnection } from "../../observability/metrics.js";
import type { ScopedRequest } from "../../core/request.js";

export const CONNECTION_HEADER = "x-sightline-connection";

function headerValue(req: ScopedRequest, name: string): string | undefined {
  const raw = req.headers?.[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * Which connection this request is about.
 *
 * The header wins; with none, the tenant's oldest connection is used so the API
 * is usable before the UI has chosen one. That default is safe in a way a
 * default *tenant* would not be — it only ever picks among accounts this tenant
 * has already connected.
 *
 * A tenant with no connections gets a refusal naming the next step, rather than
 * an empty graph that reads as "your account contains nothing".
 */
async function connectionFor(req: ScopedRequest, tenantId: TenantId, fallback?: ConnectionId) {
  const requested = headerValue(req, CONNECTION_HEADER);
  if (requested) {
    let id: ConnectionId;
    try {
      id = asConnectionId(requested);
    } catch {
      // A branded-id constructor throws a plain Error, which Nest would turn
      // into a 500 - and a header the client got wrong is the client's problem.
      throw new BadRequestException({ error: "That connection id is not a valid id" });
    }
    /**
     * Matched on the tenant as well as the id, so a connection belonging to
     * someone else is reported as simply not existing.
     *
     * Every query below filters on the tenant too, so an unchecked id would
     * return nothing rather than another tenant's rows - but "no such
     * connection" leaks nothing, while "that exists and is not yours" would
     * confirm that it exists.
     */
    const [owned] = await db
      .select({ id: connections.id })
      .from(connections)
      .where(and(eq(connections.id, id), eq(connections.tenantId, tenantId)));
    if (!owned) throw new BadRequestException({ error: "No such connection" });
    return id;
  }

  if (fallback) return fallback;

  /**
   * Nobody named a connection, so the tenant's oldest is used.
   *
   * Safe - it only ever picks among this tenant's own accounts - but it is
   * also what made two resource panels answer about the wrong AWS account
   * after a bare `fetch` dropped the header. A number climbing here means a
   * client is not sending it.
   */
  requestsWithoutConnection.inc();

  const [first] = await db
    .select({ id: connections.id })
    .from(connections)
    // An organization holds no inventory of its own; its accounts do.
    .where(and(eq(connections.tenantId, tenantId), ne(connections.kind, "organization")))
    .orderBy(asc(connections.createdAt))
    .limit(1);

  if (!first) {
    throw new ConflictException({
      error: "No AWS account is connected yet. Connect one to start scanning.",
      code: "NO_CONNECTION",
    });
  }
  return asConnectionId(first.id);
}

/**
 * The scope for this request.
 *
 * Async because hosted mode has to look up which of the tenant's accounts is
 * being asked about. Called from the guard, so the cost falls only on routes
 * that are authenticated in the first place.
 */
export async function resolveScope(req: ScopedRequest): Promise<Scope> {
  if (!isHosted()) {
    /**
     * Self-hosted honours an explicit connection too - that is how the account
     * switcher moves between the demo fixture and a real account without
     * restarting or rewriting `.env` - and it goes through **the same**
     * validation as hosted mode.
     *
     * It briefly did not, on the grounds that every read filters on the tenant
     * anyway, so a foreign id returns nothing. True, and still wrong twice
     * over: a mistyped id showed an empty graph rather than an error, and it
     * left self-hosted on a code path hosted mode never takes - which is the
     * thing "one tenant that always exists" was meant to avoid.
     */
    const scope = localScope();
    /**
     * The lookup runs inside a tenant context of its own.
     *
     * `connections` is one of the row-level-security tables, and this runs in
     * the guard - before the interceptor that opens the context for the
     * handler. Without this the very query that decides *which* connection a
     * request is about would be the one query not scoped to a tenant, and
     * under RLS it would return nothing: every request would report having no
     * connection at all.
     *
     * The tenant is known here even though the connection is not, which is
     * what makes this possible at all. `withTenant` reuses an outer context
     * when one exists, so the extra acquisition only happens on this path.
     */
    return withTenant(scope.tenantId, async () => ({
      ...scope,
      connectionId: await connectionFor(req, scope.tenantId, scope.connectionId),
    }));
  }

  const tenantId = req.tenantId;
  if (!tenantId) {
    // The guard resolves a scope only after authenticating, so reaching here
    // means a route asked for one while being public.
    throw new BadRequestException({
      error: "This route has no tenant, so it cannot read tenant data.",
    });
  }
  return withTenant(tenantId, async () => ({
    tenantId: asTenantId(tenantId),
    connectionId: await connectionFor(req, tenantId),
  }));
}
