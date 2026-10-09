/**
 * The Trust panel's endpoints.
 *
 * "How do you know the agent is right?" is a fair question from someone about
 * to act on an answer, and answering it inside the product is more use than
 * answering it in a README. Two tiers, matching ADR-008:
 *
 *   - ground-truth checks, run on demand: free, instant, no API key, and they
 *     validate the data the user is currently looking at.
 *   - the last recorded agent eval run, read from Postgres: costs money to
 *     produce, so it is displayed rather than re-run from a web request.
 */

import { Controller, Get, HttpCode, Inject, Post } from "@nestjs/common";

import { EvalsService } from "./evals.service.js";

@Controller("api/evals")
export class EvalsController {
  // The token is named explicitly — see ADR-017.
  constructor(@Inject(EvalsService) private readonly evals: EvalsService) {}

  @Get("checks")
  checks() {
    return this.evals.describeChecks();
  }

  // 200, not Nest's default 201: nothing is created, and the frontend
  // and the contract tests both expect the status this returned before.
  @Post("ground-truth")
  @HttpCode(200)
  groundTruth() {
    return this.evals.groundTruth();
  }

  @Get("latest")
  latest() {
    return this.evals.latest();
  }
}
