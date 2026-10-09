import { Module } from "@nestjs/common";

import { GraphController } from "./graph.controller.js";
import { GraphService } from "./graph.service.js";

@Module({ controllers: [GraphController], providers: [GraphService] })
export class GraphModule {}
