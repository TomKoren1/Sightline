import { Module } from "@nestjs/common";

import { EvalsController } from "./evals.controller.js";
import { EvalsService } from "./evals.service.js";

@Module({ controllers: [EvalsController], providers: [EvalsService] })
export class EvalsModule {}
