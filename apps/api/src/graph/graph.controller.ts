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

import type { AuthedRequest } from "../core/request.js";

import { CurrentScope } from "../tenancy/currentScope.decorator.js";
import type { Scope } from "../core/scope.js";
import { FINDING_LISTS, GraphService, type FindingList } from "./graph.service.js";
import { FINDING_CATEGORIES, findingsAcrossAccounts } from "../db/findings.js";
import type { FindingCategory } from "../db/schema.js";
import { MinRole } from "../core/access.js";

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
    @Query() query: { region?: string; kinds?: string; limit?: string; group?: string },
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

  /** The groups a large account is browsed by: its VPCs, then kinds outside one. */
  @Get("graph/groups")
  graphGroups(@CurrentScope() scope: Scope) {
    return this.graph.groups(scope);
  }

  /** One resource and its direct neighbours, to expand the view around it. */
  @Get("graph/neighbours")
  neighbours(@CurrentScope() scope: Scope, @Query("arn") arn: string | undefined) {
    if (!arn) throw new BadRequestException({ error: "arn is required" });
    return this.graph.neighbours(scope, arn);
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

  /** The next page of one findings list: `?list=idle&offset=50`. */
  @Get("findings/page")
  findingsPage(@CurrentScope() scope: Scope, @Query() query: { list?: string; offset?: string }) {
    const list = query.list;
    if (!list || !(list in FINDING_LISTS)) {
      throw new BadRequestException({
        error: `list is one of ${Object.keys(FINDING_LISTS).join(", ")}.`,
      });
    }
    const offset = Math.max(0, Math.floor(Number(query.offset ?? 0) || 0));
    return this.graph.findingsPage(scope, list as FindingList, offset);
  }

  /** Open findings in every account of the workspace, worst first. */
  @Get("findings/accounts")
  findingsAcrossAccounts(@CurrentScope() scope: Scope, @Query() query: { category?: string }) {
    const category = query.category;
    if (category !== undefined && !(FINDING_CATEGORIES as string[]).includes(category)) {
      throw new BadRequestException({
        error: `category is one of ${FINDING_CATEGORIES.join(", ")}.`,
      });
    }
    return findingsAcrossAccounts(scope.tenantId, {
      ...(category ? { category: category as FindingCategory } : {}),
      limit: 200,
    });
  }

  @MinRole("member")
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
