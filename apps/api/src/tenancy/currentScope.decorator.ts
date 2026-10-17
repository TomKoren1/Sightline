/**
 * `@CurrentScope()` — how a controller asks whose data this request is about.
 *
 * A parameter decorator rather than something a service reads for itself, so
 * the scope is visible in every handler's signature: a route that reads tenant
 * data without one is then obvious at a glance.
 *
 * The scope was resolved in the guard, which is the one place that decides it.
 * If resolving failed — most often a tenant who has connected no AWS account
 * yet — the error is raised *here*, so it lands on the routes that wanted a
 * connection and not on the ones they need in order to create one.
 */

import {
  createParamDecorator,
  InternalServerErrorException,
  type ExecutionContext,
} from "@nestjs/common";

import type { AuthedRequest } from "../auth/auth.guard.js";
import type { Scope } from "./scope.js";

export const CurrentScope = createParamDecorator((_data: unknown, ctx: ExecutionContext): Scope => {
  const outcome = ctx.switchToHttp().getRequest<AuthedRequest>().scopeOutcome;
  if (!outcome) {
    // The guard attaches this to every request it lets through, so an absent
    // outcome means a route asked for a scope while being exempt from the
    // guard entirely.
    throw new InternalServerErrorException({
      error: "This route is not behind the authentication guard, so it has no scope.",
    });
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.scope;
});
