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

import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";

import { AppModule } from "./app.module.js";
import { cfg, isHosted } from "./config.js";
import { InvalidIdFilter, SchemaErrorFilter } from "./malformedRequest.filter.js";
import { loggerOptions } from "./observability/logging.js";

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
