/** The audit trail: recorded for every change, readable by administrators. */

import { Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";

import { AuditController } from "./audit.controller.js";
import { AuditInterceptor } from "./audit.interceptor.js";

@Module({
  controllers: [AuditController],
  // Global, like the tenant scope: an interceptor per controller is one a new
  // controller can leave out, and its changes would go unrecorded.
  providers: [{ provide: APP_INTERCEPTOR, useClass: AuditInterceptor }],
})
export class AuditModule {}
