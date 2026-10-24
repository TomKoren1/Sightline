/**
 * One guard, registered globally, doing the three things a request needs before
 * a controller sees it: who is asking, whose data this is about, and whether
 * the request could have been forged by another site.
 *
 * Global rather than per-route, because per-route protection is opt-in and a
 * route added later is then unprotected until somebody remembers — with nothing
 * failing in the meantime. Here forgetting `@Public()` makes a route refuse
 * requests, which is noticed at once.
 */

import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import { isHosted } from "../core/config.js";
import { resolveScope } from "../tenancy/requestScope.js";
import { configuredProviders } from "./oauth.js";
import { IS_PUBLIC } from "./public.decorator.js";
import { readSession, SESSION_COOKIE } from "./session.js";
import {
  atLeast,
  HUMAN_ONLY,
  MIN_ROLE,
  RECENT_SIGN_IN,
  RECENT_SIGN_IN_MINUTES,
  type TeamRole,
} from "../core/access.js";
import { readApiToken } from "./apiTokens.js";
import { markVerified } from "./verifiedCredentials.js";
import type { AuthedRequest } from "../core/request.js";

/** Methods that change something, and therefore need forgery protection. */
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * A header a cross-site form cannot set.
 *
 * `SameSite=Lax` on the session cookie is the primary defence and already
 * refuses a cross-site POST. This is the second layer, because one layer is a
 * single mistake away from none: a custom header cannot be produced by a plain HTML form,
 * and a cross-origin `fetch` that tries triggers a preflight this service's
 * CORS configuration does not answer.
 */
const REQUEST_HEADER = "x-sightline-request";

async function attachScope(req: AuthedRequest): Promise<void> {
  try {
    const scope = await resolveScope(req);
    req.scopeOutcome = { ok: true, scope };
    /**
     * Recorded on the request so `TenantScopeInterceptor` can open the
     * connection context without resolving the scope a second time.
     *
     * Hosted sets this from the session above; self-hosted has no session and
     * derives the tenant from the local one, so without this line the
     * interceptor found no tenant in a clone and every handler's query ran
     * outside a context.
     */
    req.tenantId = scope.tenantId;
  } catch (error) {
    req.scopeOutcome = { ok: false, error };
  }
}

function bearerToken(header: unknown): string | null {
  if (typeof header !== "string") return null;
  // A malformed Authorization header is an empty token - refused - rather
  // than no header, which would fall back to the cookie.
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1]! : "";
}

@Injectable()
export class AuthGuard implements CanActivate {
  // The token is named explicitly: `emitDecoratorMetadata` is deliberately off
  // in this package, so Nest cannot infer a constructor parameter's type and
  // an unannotated dependency arrives as `undefined` at the first request
  // rather than failing at startup.
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);

    /**
     * Self-hosted has one tenant and no sign-in, so there is nobody to
     * authenticate and nothing to forge a request on behalf of. The scope is
     * still resolved and attached here, so controllers take the same path in
     * both modes rather than one that is only exercised in production.
     */
    if (!isHosted()) {
      await attachScope(req);
      return true;
    }

    // A bearer token, when one is sent, is the whole identity: the cookie
    // beside it is ignored rather than tried as a fallback.
    const bearer = bearerToken(req.headers?.["authorization"]);
    const session =
      bearer !== null
        ? await readApiToken(bearer)
        : await readSession(req.cookies?.[SESSION_COOKIE]);
    req.session = session;
    if (session) {
      req.tenantId = session.tenantId;
      markVerified(bearer ?? req.cookies?.[SESSION_COOKIE] ?? "");
    }

    if (isPublic) return true;

    if (!session) {
      throw new UnauthorizedException({
        error: "Not signed in",
        providers: configuredProviders(),
      });
    }

    const marked = (key: string) =>
      this.reflector.getAllAndOverride<boolean>(key, [context.getHandler(), context.getClass()]);
    const needsRecent = marked(RECENT_SIGN_IN);

    if (session.via === "token" && (needsRecent || marked(HUMAN_ONLY))) {
      throw new ForbiddenException({
        error: "An API token cannot do this; sign in to manage tokens, the team or the account.",
      });
    }

    if (
      needsRecent &&
      (!session.signedInAt ||
        Date.now() - session.signedInAt.getTime() > RECENT_SIGN_IN_MINUTES * 60 * 1000)
    ) {
      throw new ForbiddenException({
        error: `For safety this needs a sign-in from the last ${RECENT_SIGN_IN_MINUTES} minutes. Sign out, sign back in, and try again.`,
        reauth: true,
      });
    }

    // Forgery protection is for what a browser sends on its own - its cookie.
    // A bearer token is never attached by a browser to a request another site
    // makes, so a request carrying one was written by whoever holds it.
    if (
      session.via !== "token" &&
      MUTATING.has(req.method ?? "GET") &&
      req.headers?.[REQUEST_HEADER] !== "1"
    ) {
      throw new ForbiddenException({
        error:
          "This request is missing the X-Sightline-Request header, which Sightline requires on " +
          "anything that changes state so that another site cannot make it on your behalf.",
      });
    }

    // What their role allows: what the route names, else `member` to change
    // anything and `viewer` to read.
    const min =
      this.reflector.getAllAndOverride<TeamRole | undefined>(MIN_ROLE, [
        context.getHandler(),
        context.getClass(),
      ]) ?? (MUTATING.has(req.method ?? "GET") ? "member" : "viewer");
    if (!atLeast(session.role, min)) {
      throw new ForbiddenException({
        error: `This needs the ${min} role or above, and you are a ${session.role} in this workspace. An admin can change that.`,
      });
    }

    await attachScope(req);
    return true;
  }
}
