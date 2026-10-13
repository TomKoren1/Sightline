/** A tenant's AWS accounts. */

import { Module } from "@nestjs/common";

import { ConnectionsController } from "./connections.controller.js";

@Module({ controllers: [ConnectionsController] })
export class TenancyModule {}
