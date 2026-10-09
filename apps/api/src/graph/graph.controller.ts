import { Controller, Get, Inject, Param, Query } from "@nestjs/common";

import { GraphService } from "./graph.service.js";

@Controller("api")
export class GraphController {
  // The token is named explicitly — see HealthController and ADR-017.
  constructor(@Inject(GraphService) private readonly graph: GraphService) {}

  @Get("summary")
  summary() {
    return this.graph.summary();
  }

  @Get("graph")
  fetchGraph(@Query() query: { region?: string; kinds?: string; limit?: string }) {
    return this.graph.graph(query);
  }

  @Get("resources/:arn")
  resource(@Param("arn") arn: string) {
    return this.graph.resource(arn);
  }

  @Get("resources/:arn/remediation")
  remediation(@Param("arn") arn: string) {
    return this.graph.remediation(arn);
  }

  @Get("search")
  search(@Query("q") text?: string) {
    return this.graph.search(text);
  }

  @Get("findings")
  findings() {
    return this.graph.findings();
  }
}
