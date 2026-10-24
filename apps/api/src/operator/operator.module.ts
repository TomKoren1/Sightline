import { Module } from "@nestjs/common";

import { OperatorController } from "./operator.controller.js";

@Module({ controllers: [OperatorController] })
export class OperatorModule {}
