/**
 * A request that could never have succeeded is the client's error, not a 500.
 *
 * Two filters, one rationale. `500` tells an operator to go and look at the
 * server and tells a client to retry; both are wrong when the request can never
 * succeed as sent, and both cost real time - a 500 in a log is a thing somebody
 * investigates.
 *
 * Registered globally rather than handled per route, which is the whole point.
 * Every instance of this found so far was a route that forgot:
 *
 *   - five routes answered 500 to a mistyped uuid, and one of them had the same
 *     problem fixed on a different code path into the same handler - the header
 *     was validated, the path parameter was not;
 *   - both routes that validate a body with Zod answered 500 to an invalid one,
 *     while a third route that happened to use `safeParse` answered 400.
 *
 * A per-route fix would have left the next route to take an id, or to parse a
 * body, with the bug again and nothing failing in the meantime. The same
 * argument as the auth guard being global: forgetting must not be silent.
 *
 * `tenancy/invalidId.test.ts` holds it to that over the real route table.
 */

import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { ZodError } from "zod";

import { InvalidId } from "./tenancy/ids.js";

/** 400 with a body shaped like every other error this API returns. */
function badRequest(host: ArgumentsHost, body: Record<string, unknown>): void {
  const reply = host.switchToHttp().getResponse<FastifyReply>();
  void reply.code(HttpStatus.BAD_REQUEST).send(body);
}

/**
 * A path parameter, header or body field that is not a uuid.
 *
 * The message names which kind of id was wrong and never echoes the value: it
 * is attacker-controlled, and saying "Invalid scan id" is already everything
 * the caller needs.
 */
@Catch(InvalidId)
export class InvalidIdFilter implements ExceptionFilter<InvalidId> {
  catch(exception: InvalidId, host: ArgumentsHost): void {
    badRequest(host, { error: exception.message });
  }
}

/**
 * A body that does not match its schema.
 *
 * `details` carries Zod's own field errors, matching what `POST /api/chat`
 * already returned by handling this itself - so the shape a client sees is the
 * same whether the route validates by hand or lets this catch it.
 */
@Catch(ZodError)
export class SchemaErrorFilter implements ExceptionFilter<ZodError> {
  catch(exception: ZodError, host: ArgumentsHost): void {
    badRequest(host, { error: "Invalid request", details: exception.flatten() });
  }
}
