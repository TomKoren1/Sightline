/** Sign-in, sessions, and the global guard that protects everything else. */

import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";

import { AuthController, MeController } from "./auth.controller.js";
import { AuthGuard } from "./auth.guard.js";
import { TeamController } from "./team.controller.js";

@Module({
  controllers: [AuthController, MeController, TeamController],
  /**
   * `APP_GUARD` rather than `@UseGuards` on each controller.
   *
   * A guard listed per controller is one a new controller can omit, and nothing
   * fails when it does. Registered here it applies to every route in the
   * application, and a route escapes only by saying so with `@Public()`.
   */
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
})
export class AuthModule {}
