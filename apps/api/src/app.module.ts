/** The root module: the list of feature modules, one per area of the API. */

import { Module } from "@nestjs/common";

import { ChatModule } from "./chat/chat.module.js";
import { ConnectionModule } from "./connection/connection.module.js";
import { EvalsModule } from "./evals/evals.module.js";
import { GraphModule } from "./graph/graph.module.js";
import { ScansModule } from "./scans/scans.module.js";
import { HealthModule } from "./health/health.module.js";

@Module({
  imports: [HealthModule, GraphModule, EvalsModule, ScansModule, ChatModule, ConnectionModule],
})
export class AppModule {}
