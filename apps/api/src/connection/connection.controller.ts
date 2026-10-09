/**
 * Connection endpoints: what account this deployment is pointed at, how to
 * switch, and why a real one is refusing to connect.
 *
 * Nothing here writes a credential or touches `.env` — that is `npm run setup`,
 * which runs on the host where the AWS CLI and the file both are (ADR-015).
 */

import { Body, Controller, Get, HttpCode, Inject, Post } from "@nestjs/common";

import { ConnectionService } from "./connection.service.js";

@Controller("api/connection")
export class ConnectionController {
  // The token is named explicitly — see ADR-017.
  constructor(@Inject(ConnectionService) private readonly connection: ConnectionService) {}

  @Get()
  state() {
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
    return this.connection.test();
  }
}
