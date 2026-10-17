/**
 * Connection endpoints: what account this deployment is pointed at, how to
 * switch, and why a real one is refusing to connect.
 *
 * Nothing here writes a credential or touches `.env` — that is `npm run setup`,
 * which runs on the host where the AWS CLI and the file both are.
 */

import { Body, Controller, ConflictException, Get, HttpCode, Inject, Post } from "@nestjs/common";

import { isHosted } from "../config.js";
import { ConnectionService } from "./connection.service.js";

/**
 * Refuse the whole surface in hosted mode.
 *
 * Every endpoint here describes **the process's** one connection, which is the
 * right shape for a single operator and meaningless for a tenant. Worse than
 * meaningless in one case: the connection test builds its STS clients from
 * `isMock()` and `AWS_ENDPOINT_URL`, both of which carry defaults that point at
 * a local mock - so in hosted mode it aimed signed calls at localhost. Found by
 * booting hosted mode and reading the redirect.
 *
 * `isMock()` now answers no in hosted mode, which fixes that specific hole.
 * This is the layer that makes the whole class of them unreachable, and it goes
 * away when the per-connection replacement lands.
 */
function refuseWhenHosted(): void {
  if (!isHosted()) return;
  throw new ConflictException({
    error:
      "This deployment holds one connection per account, not one per process. " +
      "See GET /api/connections.",
    code: "NOT_APPLICABLE",
  });
}

@Controller("api/connection")
export class ConnectionController {
  // The token is named explicitly.
  constructor(@Inject(ConnectionService) private readonly connection: ConnectionService) {}

  @Get()
  state() {
    refuseWhenHosted();
    return this.connection.state();
  }

  // 200, not Nest's default 201: nothing is created, and the frontend
  // and the contract tests both expect the status this returned before.
  @Post("mode")
  @HttpCode(200)
  setMode(@Body() body: { mode?: string } | undefined) {
    return this.connection.setMode(body);
  }

  @Get("external-id")
  externalId() {
    return this.connection.newExternalId();
  }

  // 200, not Nest's default 201: nothing is created, and the frontend
  // and the contract tests both expect the status this returned before.
  @Post("test")
  @HttpCode(200)
  test() {
    refuseWhenHosted();
    return this.connection.test();
  }
}
