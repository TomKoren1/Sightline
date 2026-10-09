import { Module } from "@nestjs/common";

import { ScanStateService } from "./scanState.service.js";
import { ScansController } from "./scans.controller.js";
import { ScansService } from "./scans.service.js";

@Module({
  controllers: [ScansController],
  providers: [ScansService, ScanStateService],
  // The chat module refuses to answer from an empty graph, so it needs to know
  // whether a scan has ever completed.
  exports: [ScansService],
})
export class ScansModule {}
