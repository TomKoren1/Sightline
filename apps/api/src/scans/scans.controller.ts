import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ScanEvent } from "@sightline/shared";

import type { AuthedRequest } from "../core/request.js";
import { ScanAlreadyQueued } from "../jobs/queue.js";
import { ScanRefused } from "./scanRefused.js";
import { asJobId, asScanId, type JobId } from "../core/ids.js";
import { CurrentScope } from "../tenancy/currentScope.decorator.js";
import type { Scope } from "../core/scope.js";
import { ScansService } from "./scans.service.js";
import { MinRole } from "../core/access.js";

/** Headers that stop a reverse proxy buffering an event stream. */
const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  // Without this, a reverse proxy will happily buffer the whole stream and
  // deliver it at the end, which defeats the point.
  "X-Accel-Buffering": "no",
} as const;

@Controller("api/scans")
export class ScansController {
  // The token is named explicitly.
  constructor(@Inject(ScansService) private readonly scans: ScansService) {}

  @Get()
  list(@CurrentScope() scope: Scope) {
    return this.scans.list(scope);
  }

  // Declared before `:id`, or Fastify would route "latest", "diff" and "jobs"
  // into it.
  @Get("latest")
  latest(@CurrentScope() scope: Scope) {
    return this.scans.latest(scope);
  }

  @Get("diff")
  diff(@CurrentScope() scope: Scope, @Query() query: { from?: string; to?: string }) {
    /**
     * Validated here, at the boundary, because this is where the untrusted
     * value is. Both are uuid columns in Postgres, and passing a mistyped one
     * through produced `invalid input syntax for type uuid` and a 500 - the
     * service now takes `ScanId`, so forgetting this is a compile error rather
     * than a 500 somebody reports later.
     */
    return this.scans.diff(scope, {
      ...(query.from ? { from: asScanId(query.from) } : {}),
      ...(query.to ? { to: asScanId(query.to) } : {}),
    });
  }

  /** A job's state without opening a stream, for a client that just wants it. */
  @Get("jobs/:jobId")
  job(@CurrentScope() scope: Scope, @Param("jobId") jobId: string) {
    return this.scans.progress(scope, asJobId(jobId));
  }

  /**
   * Rejoin a scan already in flight.
   *
   * This is the endpoint that makes a reload harmless. `GET /api/scans/latest`
   * names the active job; this streams it from wherever it has got to, with the
   * full unit list as it currently stands rather than only the events that
   * happen to arrive after connecting.
   */
  @Get("jobs/:jobId/stream")
  async stream(
    @CurrentScope() scope: Scope,
    @Param("jobId") jobId: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    // Checked before a byte of the stream is written, so a bad id is a 404
    // rather than an empty event stream that closes immediately.
    const id = asJobId(jobId);
    const job = await this.scans.job(scope, id);
    if (!job) return reply.code(404).send({ error: "No such scan job" });

    await this.pipe(scope, id, req, reply);
  }

  @Get(":id")
  byId(@CurrentScope() scope: Scope, @Param("id") id: string) {
    return this.scans.byId(scope, asScanId(id));
  }

  /**
   * Ask for a scan, and stream its progress.
   *
   * The scan itself runs in a worker; this enqueues it and then streams the
   * same view of it that `jobs/:jobId/stream` does, so the request that started
   * a scan is no longer the only thing that can watch one. Closing this
   * response no longer cancels anything - which is the point, and is why
   * `scan.queued` exists for the UI to show.
   */
  @MinRole("member")
  @Post()
  async run(@CurrentScope() scope: Scope, @Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    const userId = (req as AuthedRequest).session?.userId ?? null;

    let jobId: JobId;
    try {
      jobId = (await this.scans.enqueue(scope, userId)).id;
    } catch (err) {
      if (err instanceof ScanAlreadyQueued) {
        /**
         * 409 with the job id, so pressing Scan twice attaches to the scan
         * already running instead of reporting an error for having asked. The
         * UI needs the id to do that, which is why the exception carries it.
         */
        return reply.code(409).send({
          error: "A scan of this account is already running",
          activeJobId: err.existingJobId,
        });
      }
      if (err instanceof ScanRefused) {
        /**
         * 429 or 503, and `Retry-After` when waiting is the answer.
         *
         * Never 403: nothing about this caller is forbidden, they are early or
         * the deployment is paused, and both stop being true. 429 and 503 are
         * then distinguished because telling somebody who made one request that
         * they have made too many is misleading - the refusal says which it is.
         * The header is set as well as the body so a client that honours it does
         * the right thing without reading the message.
         */
        if (err.retryAfterSeconds !== undefined) {
          void reply.header("Retry-After", String(err.retryAfterSeconds));
        }
        return reply.code(err.status).send({
          error: err.message,
          ...(err.retryAfterSeconds !== undefined
            ? { retryAfterSeconds: err.retryAfterSeconds }
            : {}),
        });
      }
      throw err;
    }

    await this.pipe(scope, jobId, req, reply);
  }

  /**
   * Cancel a queued scan.
   *
   * Only one that has not started. A running scan is left alone and says so,
   * rather than being marked cancelled while a worker carries on writing to it.
   */
  @MinRole("member")
  @Delete("jobs/:jobId")
  @HttpCode(200)
  async cancel(@CurrentScope() scope: Scope, @Param("jobId") jobId: string) {
    const cancelled = await this.scans.cancel(scope, asJobId(jobId));
    return cancelled
      ? { cancelled: true }
      : {
          cancelled: false,
          note: "This scan has already started, so it was left to finish rather than being marked cancelled while still running.",
        };
  }

  /**
   * Write a job's events to the socket until it ends or the client goes away.
   *
   * Written to the raw socket through `@Res()` rather than through Nest's
   * `@Sse()`, deliberately. `@Sse()` serialises an Observable into its own wire
   * format; the frontend already parses this one, and taking `@Res()` puts Nest
   * out of the way for a hand-managed stream.
   */
  private async pipe(
    scope: Scope,
    jobId: JobId,
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    reply.raw.writeHead(200, SSE_HEADERS);

    const events = this.scans.events(scope, jobId);

    /**
     * Stop reading the moment the client disconnects.
     *
     * Without this a closed tab leaves the generator polling Postgres once a
     * second for as long as the scan runs - per abandoned tab. `return()` ends
     * the generator at its next suspension point, which is the poll's own
     * timer.
     */
    let closed = false;
    const onClose = () => {
      closed = true;
      void events.return(undefined);
    };
    reply.raw.on("close", onClose);

    try {
      for await (const event of events) {
        if (closed) break;
        reply.raw.write(`data: ${JSON.stringify(event satisfies ScanEvent)}\n\n`);
      }
    } catch (err) {
      req.log.error({ err, jobId }, "scan event stream failed");
    } finally {
      reply.raw.off("close", onClose);
      if (!closed) reply.raw.end();
    }
  }
}
