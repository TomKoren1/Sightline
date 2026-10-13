/**
 * `@CurrentScope()` — how a controller asks whose data this request is about.
 *
 * A parameter decorator rather than something a service reads for itself, so
 * the scope is visible in every handler's signature. A route that reads tenant
 * data without one is then obvious at a glance, and the route-coverage test
 * can find it.
 */

import { createParamDecorator, type ExecutionContext } from "@nestjs/common";

import { scopeForRequest, type ScopedRequest } from "./requestScope.js";
import type { Scope } from "./scope.js";

export const CurrentScope = createParamDecorator((_data: unknown, ctx: ExecutionContext): Scope =>
  scopeForRequest(ctx.switchToHttp().getRequest<ScopedRequest>()),
);
