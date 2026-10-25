/**
 * A request that could never have succeeded is the client's error, not a 500.
 *
 * Two filters, one rationale: a 500 tells an operator to investigate and a
 * client to retry, and both are wrong when the request cannot succeed as sent.
 *
 * Registered globally, which is the point. Five routes answered 500 to a
 * mistyped uuid - one of them already fixed on a different path into the same
 * handler - and both routes that validate a body with Zod answered 500 to an
 * invalid one. A per-route fix leaves the next route to take an id with the bug
 * again and nothing failing meanwhile.
 *
 * `tenancy/invalidId.test.ts` holds it to that over the real route table.
 */

import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { ZodError } from "zod";

import { InvalidId } from "../core/ids.js";

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
