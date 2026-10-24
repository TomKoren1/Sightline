/**
 * The Nest application: every route, no listener.
 *
 * Built on Fastify rather than Express, deliberately. The HTTP behaviour
 * underneath is the one this project already had — the SSE endpoints write to
 * the raw socket, and `maxParamLength` below is a Fastify router setting that
 * a whole class of IAM ARNs depends on. Swapping the server as well as the
 * framework would have made every difference in behaviour ambiguous.
 *
 * Routes live in feature modules (`health/`, `graph/`, `scans/`, `chat/`,
 * `evals/`, `connection/`), each a controller over a service. `app.module.ts`
 * is the list.
 */

import "reflect-metadata";
import { HttpException } from "@nestjs/common";

import cookie from "@fastify/cookie";
import rateLimit, { type RateLimitPluginOptions } from "@fastify/rate-limit";
import cors from "@fastify/cors";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { httpDuration, httpInFlight, httpRequests } from "./observability/metrics.js";

import { AppModule } from "./app.module.js";
import { cfg, isHosted } from "./config.js";
import { InvalidIdFilter, SchemaErrorFilter } from "./malformedRequest.filter.js";
import { loggerOptions } from "./observability/logging.js";
import { SESSION_COOKIE } from "./auth/session.js";
import { credentialKey, isVerified } from "./auth/verifiedCredentials.js";

/** One registered route, as Fastify sees it. */
export interface RouteInfo {
  method: string;
  url: string;
}

export interface BuildOptions {
  /**
   * Called for every route as it is registered.
   *
   * Exists for `auth/enforcement.test.ts`, which asserts that every route is
   * either published as public or answers 401 without a session. It takes the
   * **real** route table rather than a list maintained alongside it, because a
   * second list is a list that disagrees - and the whole value of that test is
   * that a route added later cannot escape it.
   */
  onRoute?: (route: RouteInfo) => void;
}

export async function buildApp(options: BuildOptions = {}): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({
    // Redaction included, so an ExternalId cannot reach a log through an object
    // somebody logged whole - see `observability/logging.ts`.
    logger: loggerOptions(),
    // SSE responses are written directly to the raw socket and can outlive the
    // default timeout on a slow scan.
    connectionTimeout: 0,
    requestTimeout: 0,

    /**
     * ARNs travel as a path parameter, and Fastify's default cap is 100
     * characters.
     *
     * That default is a routing-performance guard, not a security control, and
     * far too low here: a service-linked role's ARN percent-encodes to 136
     * characters, and every one of them returned HTTP 414 with an empty detail
     * panel. 2048 is the practical ceiling for an ARN;
     * anything beyond that is not an ARN this system produced.
     */
    maxParamLength: 2048,

    /**
     * `/api/v1/...` is the same API as `/api/...`: the published, versioned
     * prefix for scripts holding an API token. One route table, so the two
     * cannot drift; a breaking change gets `/api/v2` and its own handlers
     * rather than changing what v1 answers. The UI keeps the bare prefix.
     */
    rewriteUrl: (req) => (req.url ?? "/").replace(/^\/api\/v1(?=[/?]|$)/, "/api"),
  });

  if (options.onRoute) {
    const onRoute = options.onRoute;
    adapter
      .getInstance()
      .addHook("onRoute", (route) => onRoute({ method: String(route.method), url: route.url }));
  }

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    // Fastify already logs every request. Nest's logger is kept to the things
    // Fastify would not say, so the two do not report the same event twice in
    // two formats.
    logger: ["error", "warn"],
  });

  const instance = app.getHttpAdapter().getInstance();

  // Sessions are a cookie, so something has to parse them. No secret: the
  // cookie's value is an opaque token checked against the database, not a
  // signed payload.
  await instance.register(cookie);

  /**
   * CORS is reflective in self-hosted and locked to the one origin in hosted.
   *
   * `origin: true` echoes whatever Origin asked, which is right for a developer
   * running the UI on an arbitrary port and wrong for a public deployment:
   * echoing an attacker's origin is most of what is needed to make the custom-
   * header CSRF check in `auth.guard.ts` answerable by a preflight.
   */
  await instance.register(cors, {
    origin: isHosted() ? [cfg.PUBLIC_BASE_URL.replace(/\/$/, "")] : true,
    credentials: isHosted(),
  });

  if (isHosted()) await instance.register(rateLimit, rateLimitOptions());

  /**
   * Request rate, errors and duration, by route *template*.
   *
   * `routeOptions.url` is `/api/scans/jobs/:id`, not the path - a label of the
   * path would make every job id its own time series. An unmatched request is
   * labelled once rather than by whatever was probed, for the same reason.
   *
   * `reply.elapsedTime` is Fastify's own measurement, so this adds no clock of
   * its own and cannot disagree with the access log.
   */
  instance.addHook("onRequest", (_req, _reply, done) => {
    httpInFlight.inc();
    done();
  });
  instance.addHook("onResponse", (req, reply, done) => {
    httpInFlight.dec();
    const route = req.routeOptions?.url ?? "unmatched";
    const labels = { method: req.method, route };
    httpDuration.observe(labels, reply.elapsedTime / 1000);
    httpRequests.inc({ ...labels, status: String(reply.statusCode) });
    done();
  });

  /**
   * A malformed request answers 400 rather than 500, on every route.
   *
   * Global, so a route added later cannot reintroduce the 500 by forgetting -
   * the same argument as the auth guard being global rather than per route.
   */
  app.useGlobalFilters(new InvalidIdFilter(), new SchemaErrorFilter());

  await app.init();
  return app;
}

/**
 * Every endpoint, rate-limited: per session when signed in, per address when
 * not - and the sign-in routes far lower, because they are what a credential-
 * stuffing script or a redirect loop hits. In memory, so per API replica: the
 * point is a ceiling, not an exact count, and a shared store would be one more
 * thing to run. `CF-Connecting-IP` is Cloudflare's view of the visitor; the
 * API is reachable only through the web pods, so a visitor cannot set it.
 */
export function rateLimitOptions(): RateLimitPluginOptions {
  return {
    timeWindow: "1 minute",
    max: (req) =>
      req.url.startsWith("/api/auth/") ? cfg.RATE_LIMIT_AUTH_PER_MINUTE : cfg.RATE_LIMIT_PER_MINUTE,
    keyGenerator: (req) => {
      const authorization = req.headers["authorization"];
      const credential =
        typeof authorization === "string"
          ? authorization.replace(/^Bearer\s+/i, "")
          : (req.cookies as Record<string, string | undefined> | undefined)?.[SESSION_COOKIE];
      // Only one the guard has accepted: see verifiedCredentials.ts.
      if (credential && isVerified(credentialKey(credential))) {
        return `c:${credentialKey(credential)}`;
      }
      const forwarded = req.headers["cf-connecting-ip"];
      return `ip:${typeof forwarded === "string" ? forwarded : req.ip}`;
    },
    // Probes poll this every few seconds, and are not a visitor.
    allowList: (req) => req.url.startsWith("/api/health"),
    // A Nest HttpException, not a plain object: the plugin throws what this
    // returns, and Nest's error handler answers anything else with a 500.
    errorResponseBuilder: (_req, context) =>
      new HttpException(
        {
          error:
            `Too many requests: at most ${context.max} a minute. ` +
            `Try again in ${Math.ceil(context.ttl / 1000)} seconds.`,
        },
        429,
      ),
  };
}
