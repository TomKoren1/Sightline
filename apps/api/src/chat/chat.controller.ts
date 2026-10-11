/**
 * Chat endpoint.
 *
 * Streams the agent's work as server-sent events. The stream carries more than
 * tokens: every tool call and result goes down it too, so the UI can say
 * "checking network paths to northwind-prod-db" instead of showing a spinner.
 * That is the difference between a user trusting the answer and waiting for it.
 */

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import type { AgentEvent } from "@sightline/shared";

import { askSchema } from "./chat.dto.js";
import { ChatService } from "./chat.service.js";
import { errorMessage } from "@sightline/shared";

@Controller("api")
export class ChatController {
  // The token is named explicitly — see ADR-017.
  constructor(@Inject(ChatService) private readonly chat: ChatService) {}

  /**
   * Written to the raw socket through `@Res()` rather than Nest's `@Sse()`:
   * the frontend already parses this wire format, and the port was meant to
   * change the structure of the code and nothing a client can observe.
   */
  @Post("chat")
  async ask(@Body() body: unknown, @Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    const parsed = askSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({ error: "Invalid request", details: parsed.error.flatten() });
    }
    const { question, history } = parsed.data;

    // Resolved before a byte of the stream is written, so a missing scan is
    // still a status code rather than an error event nobody can act on.
    const latest = await this.chat.requireScan();
    const conversationId = parsed.data.conversationId ?? randomUUID();

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const send = (event: AgentEvent) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);

    try {
      const message = await this.chat.answer({ question, history: history ?? [], onEvent: send });

      // Persisted after the fact. A failure to persist must not lose the
      // answer the user is already reading.
      try {
        await this.chat.record({
          conversationId,
          accountId: latest.accountId,
          scanId: latest.id,
          question,
          message,
        });
      } catch (err) {
        req.log.error({ err }, "failed to persist conversation");
      }
    } catch (err) {
      const text = errorMessage(err);
      req.log.error({ err }, "agent failed");
      send({ type: "agent.failed", error: text });
    } finally {
      reply.raw.end();
    }
  }

  @Get("conversations/:id")
  conversation(@Param("id") id: string) {
    return this.chat.conversation(id);
  }
}
