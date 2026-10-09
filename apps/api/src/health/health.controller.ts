import { Controller, Get, Inject } from "@nestjs/common";

import { HealthService } from "./health.service.js";

@Controller("api")
export class HealthController {
  /**
   * `@Inject` names the token explicitly.
   *
   * Nest can normally infer it from the parameter's type, but that relies on
   * `emitDecoratorMetadata`, and esbuild — which both tsx and vitest use —
   * cannot emit it, because it needs type information the transpiler does not
   * have. Nest does not complain: it injects `undefined`, and the handler
   * fails at request time with "cannot read properties of undefined". So every
   * injection in this package names its token. See ADR-017.
   */
  constructor(@Inject(HealthService) private readonly health: HealthService) {}

  @Get("health")
  get() {
    return this.health.report();
  }
}
