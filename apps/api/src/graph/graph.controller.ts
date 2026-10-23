import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Query,
  Req,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { z } from "zod";

import type { AuthedRequest } from "../auth/auth.guard.js";

import { CurrentScope } from "../tenancy/currentScope.decorator.js";
import type { Scope } from "../tenancy/scope.js";
import { GraphService } from "./graph.service.js";

/**
 * Accepting a risk needs a reason, because the reason is the whole value of the
 * record: "accepted" alone tells the next engineer nothing about whether the
 * decision still holds. Reopening needs none.
 */
const findingStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("accepted"), reason: z.string().trim().min(3).max(500) }),
  z.object({ status: z.literal("open") }),
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller("api")
export class GraphController {
  // The token is named explicitly — see HealthController.
  constructor(@Inject(GraphService) private readonly graph: GraphService) {}

  @Get("summary")
  summary(@CurrentScope() scope: Scope) {
    return this.graph.summary(scope);
  }

  @Get("graph")
  fetchGraph(
    @CurrentScope() scope: Scope,
    @Query() query: { region?: string; kinds?: string; limit?: string },
  ) {
    /**
     * A limit that is not a number is refused, not guessed at.
     *
     * `?limit=abc` used to answer with an empty graph: the value became `NaN`,
     * survived every clamp, and arrived at the database as `LIMIT 0`. A customer who
     * mistyped a query parameter was told their AWS account held nothing. The
     * clamp is total now, so the worst case is the default rather than zero -
     * but a caller who asked for a specific number and silently got a different
     * one has also been given a wrong answer, so this says so instead.
     */
    if (query.limit !== undefined && query.limit !== "" && !/^\d+$/.test(query.limit)) {
      throw new BadRequestException({
        error: `limit must be a whole number; got ${JSON.stringify(query.limit)}`,
      });
    }
    return this.graph.graph(scope, query);
  }

  @Get("resources/:arn")
  resource(@CurrentScope() scope: Scope, @Param("arn") arn: string) {
    return this.graph.resource(scope, arn);
  }

  @Get("resources/:arn/remediation")
  remediation(@CurrentScope() scope: Scope, @Param("arn") arn: string) {
    return this.graph.remediation(scope, arn);
  }

  @Get("search")
  search(@CurrentScope() scope: Scope, @Query("q") text?: string) {
    return this.graph.search(scope, text);
  }

  @Get("findings")
  findings(@CurrentScope() scope: Scope) {
    return this.graph.findings(scope);
  }

  @Patch("findings/:id")
  setFindingStatus(
    @CurrentScope() scope: Scope,
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    // Refused here rather than by Postgres, whose answer to a malformed uuid
    // is a 500.
    if (!UUID.test(id)) throw new BadRequestException({ error: "Not a finding id" });
    const input = findingStatusSchema.parse(body ?? {});
    const session = (req as unknown as AuthedRequest).session;
    return this.graph.setFindingStatus(scope, {
      id,
      status: input.status,
      reason: input.status === "accepted" ? input.reason : null,
      actorUserId: session?.userId ?? null,
    });
  }
}
