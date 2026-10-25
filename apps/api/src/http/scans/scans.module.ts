import { Module } from "@nestjs/common";

import { ScansController } from "./scans.controller.js";
import { ScansService } from "./scans.service.js";

/**
 * `ScanStateService` is gone: "is a scan running?" is now a row in `scan_jobs`,
 * which two processes can agree about and an in-process `Set` could not.
 *
 * Nothing is exported. It used to export `ScansService` with a comment about
 * the chat module needing to know whether a scan had completed, and nothing
 * imported this module's exports - chat answers that question from the graph
 * itself. An export nobody consumes is a claim about coupling that does not
 * exist.
 */
@Module({
  controllers: [ScansController],
  providers: [ScansService],
})
export class ScansModule {}
