/** The root module: the list of feature modules, one per area of the API. */

import { Module } from "@nestjs/common";

import { AuthModule } from "./auth/auth.module.js";
import { ChatModule } from "./chat/chat.module.js";
import { ConnectionModule } from "./connection/connection.module.js";
import { EvalsModule } from "./evals/evals.module.js";
import { GraphModule } from "./graph/graph.module.js";
import { ScansModule } from "./scans/scans.module.js";
import { HealthModule } from "./health/health.module.js";
import { TenancyModule } from "./tenancy/tenancy.module.js";

@Module({
  imports: [
    // First, because it registers the global guard every other module's routes
    // are protected by.
    AuthModule,
    TenancyModule,
    HealthModule,
    GraphModule,
    EvalsModule,
    ScansModule,
    ChatModule,
    ConnectionModule,
  ],
})
export class AppModule {}
