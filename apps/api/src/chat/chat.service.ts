/**
 * Asking the agent, and the conversation record.
 *
 * The persistence is deliberately after the fact and deliberately forgiving: a
 * failure to write the transcript must not lose the answer the user is already
 * reading.
 */

import { randomUUID } from "node:crypto";
import { ConflictException, Injectable } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";
import type { AgentEvent, AgentMessage } from "@sightline/shared";

import { ask } from "../agent/agent.js";
import { db } from "../db/postgres.js";
import { conversations, messages } from "../db/schema.js";
import { getLatestScan } from "../db/repository.js";

@Injectable()
export class ChatService {
  /**
   * The scan the answer will be grounded in.
   *
   * Answering from an empty graph produces confident nonsense, so it is
   * refused with something the UI can act on rather than attempted. Resolved
   * before the stream opens, so the refusal can be a status code.
   */
  async requireScan() {
    const latest = await getLatestScan();
    if (!latest) {
      throw new ConflictException({
        error: "No scan has completed yet. Run a scan before asking questions.",
        code: "NO_SCAN",
      });
    }
    return latest;
  }

  answer(params: {
    question: string;
    history?: Array<{ role: "user" | "assistant"; content: string }>;
    onEvent: (event: AgentEvent) => void;
  }) {
    return ask({
      question: params.question,
      history: params.history ?? [],
      onEvent: params.onEvent,
    });
  }

  /** The full audit trail: which tools ran, what was cited, what was flagged. */
  async record(params: {
    conversationId: string;
    accountId: string;
    scanId: string;
    question: string;
    message: AgentMessage;
  }) {
    await db
      .insert(conversations)
      .values({ id: params.conversationId, accountId: params.accountId })
      .onConflictDoNothing();
    await db.insert(messages).values([
      {
        id: randomUUID(),
        conversationId: params.conversationId,
        role: "user",
        content: params.question,
        scanId: params.scanId,
      },
      {
        id: params.message.id,
        conversationId: params.conversationId,
        role: "assistant",
        content: params.message.content,
        toolCalls: params.message.toolCalls ?? [],
        citations: params.message.citations ?? [],
        warnings: params.message.warnings ?? [],
        scanId: params.scanId,
      },
    ]);
  }

  async conversation(id: string) {
    const rows = await db
      .select({
        id: messages.id,
        role: messages.role,
        content: messages.content,
        toolCalls: messages.toolCalls,
        citations: messages.citations,
        warnings: messages.warnings,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(eq(messages.conversationId, id))
      .orderBy(asc(messages.createdAt));

    return { messages: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })) };
  }
}
