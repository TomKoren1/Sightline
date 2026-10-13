import { Controller, Get, Inject, Param, Post, Query, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ScanEvent } from "@sightline/shared";

import { CurrentScope } from "../tenancy/currentScope.decorator.js";
import type { Scope } from "../tenancy/scope.js";
import { ScansService } from "./scans.service.js";

@Controller("api/scans")
export class ScansController {
  // The token is named explicitly.
  constructor(@Inject(ScansService) private readonly scans: ScansService) {}

  @Get()
  list(@CurrentScope() scope: Scope) {
    return this.scans.list(scope);
  }

  // Declared before `:id`, or Fastify would route "latest" and "diff" into it.
  @Get("latest")
  latest(@CurrentScope() scope: Scope) {
    return this.scans.latest(scope);
  }

  @Get("diff")
  diff(@CurrentScope() scope: Scope, @Query() query: { from?: string; to?: string }) {
    return this.scans.diff(scope, query);
  }

  @Get(":id")
  byId(@CurrentScope() scope: Scope, @Param("id") id: string) {
    return this.scans.byId(scope, id);
  }

  /**
   * Run a scan, streaming progress as server-sent events.
   *
   * Written to the raw socket through `@Res()` rather than through Nest's
   * `@Sse()`, deliberately. `@Sse()` serialises an Observable into its own
   * wire format; the frontend already parses this one, and the point of the
   * port was to change the structure of the code and nothing a client can
   * observe. Taking `@Res()` puts Nest out of the way for this handler, which
   * is exactly what a hand-managed stream needs.
   */
  @Post()
  async run(@CurrentScope() scope: Scope, @Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    if (!this.scans.claim(scope)) {
      return reply.code(409).send({ error: "A scan of this account is already running" });
    }

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Without this, a reverse proxy will happily buffer the whole stream and
      // deliver it at the end, which defeats the point.
      "X-Accel-Buffering": "no",
    });

    const send = (event: ScanEvent) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    await this.scans.run(scope, send, (err) => req.log.error({ err }, "scan failed"));
    reply.raw.end();
  }
}
