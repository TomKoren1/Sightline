import { BadRequestException, Controller, Get, Inject, Param, Query } from "@nestjs/common";

import { CurrentScope } from "../tenancy/currentScope.decorator.js";
import type { Scope } from "../tenancy/scope.js";
import { GraphService } from "./graph.service.js";

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
     * survived every clamp, and arrived at Neo4j as `LIMIT 0`. A customer who
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
}
