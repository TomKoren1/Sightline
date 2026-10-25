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
import type { AgentEvent } from "@sightline/shared";

import { CurrentScope } from "../tenancy/currentScope.decorator.js";
import { asConversationId } from "../../core/ids.js";
import { requestsRefused } from "../../observability/metrics.js";
import { mayChat, statusFor } from "../../tenancy/limits.js";
import type { Scope } from "../../core/scope.js";
import { askRequest as askSchema } from "@sightline/shared/api";
import { ChatService } from "./chat.service.js";
import { MinRole } from "../../core/access.js";
import { describeAgentFailure } from "../../agent/failure.js";

@Controller("api")
export class ChatController {
  // The token is named explicitly.
  constructor(@Inject(ChatService) private readonly chat: ChatService) {}

  /**
   * Written to the raw socket through `@Res()` rather than Nest's `@Sse()`:
   * the frontend already parses this wire format, and the port was meant to
   * change the structure of the code and nothing a client can observe.
   */
  @MinRole("viewer")
  @Post("chat")
  async ask(
    @CurrentScope() scope: Scope,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const parsed = askSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({ error: "Invalid request", details: parsed.error.flatten() });
    }
    const { question } = parsed.data;

    /**
     * Checked before a byte of the stream is written, for the same reason the
     * scan is: once the response is an event stream the status code is already
     * 200, and a quota refusal would arrive as an error event the UI renders
     * inside a chat bubble rather than as something a client can act on.
     */
    const quota = await mayChat(scope);
    if (!quota.allowed) {
      if (quota.retryAfterSeconds !== undefined) {
        void reply.header("Retry-After", String(quota.retryAfterSeconds));
      }
      // 429 when they have asked a lot of questions in an hour, 503 when an
      // operator has turned the assistant off. Never 403: nothing about this
      // caller is forbidden, and both of these stop being true.
      requestsRefused.inc({ kind: quota.kind, what: "chat" });
      return reply.code(statusFor(quota.kind)).send({
        error: quota.reason,
        ...(quota.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: quota.retryAfterSeconds }
          : {}),
      });
    }

    // Resolved before a byte of the stream is written, so a missing scan is
    // still a status code rather than an error event nobody can act on.
    const latest = await this.chat.requireScan(scope);
    const { conversationId, history } = await this.chat.continueConversation(
      scope,
      parsed.data.conversationId,
    );

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const send = (event: AgentEvent) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    send({ type: "agent.conversation", conversationId });

    try {
      const message = await this.chat.answer({
        scope,
        question,
        history,
        onEvent: send,
      });

      // Persisted after the fact. A failure to persist must not lose the
      // answer the user is already reading.
      try {
        await this.chat.record({
          scope,
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
      const text = describeAgentFailure(err);
      req.log.error({ err }, "agent failed");
      send({ type: "agent.failed", error: text });
    } finally {
      reply.raw.end();
    }
  }

  @Get("conversations/:id")
  conversation(@CurrentScope() scope: Scope, @Param("id") id: string) {
    return this.chat.conversation(scope, asConversationId(id));
  }
}
