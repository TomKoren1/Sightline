/**
 * The root module.
 *
 * Feature modules are added here as they move off the Fastify route functions
 * in `routes/`. While both exist, `app.ts` registers whatever has not moved
 * yet directly on the adapter's Fastify instance, so the HTTP surface is
 * complete at every commit and the contract tests stay green throughout.
 */

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
