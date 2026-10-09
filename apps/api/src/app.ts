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

import cors from "@fastify/cors";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";

import { AppModule } from "./app.module.js";

export async function buildApp(): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({
    logger: { level: process.env["LOG_LEVEL"] ?? "info" },
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
     * panel (engineering log #37). 2048 is the practical ceiling for an ARN;
     * anything beyond that is not an ARN this system produced.
     */
    maxParamLength: 2048,
  });

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    // Fastify already logs every request. Nest's logger is kept to the things
    // Fastify would not say, so the two do not report the same event twice in
    // two formats.
    logger: ["error", "warn"],
  });

  await app.getHttpAdapter().getInstance().register(cors, { origin: true });
  await app.init();
  return app;
}
