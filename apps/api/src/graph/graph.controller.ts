import { Controller, Get, Inject, Param, Query } from "@nestjs/common";

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
