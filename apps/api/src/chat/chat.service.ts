/**
 * Asking the agent, and the conversation record.
 *
 * The persistence is deliberately after the fact and deliberately forgiving: a
 * failure to write the transcript must not lose the answer the user is already
 * reading.
 */

import { randomUUID } from "node:crypto";
import { ConflictException, Injectable } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import type { AgentEvent, AgentMessage } from "@sightline/shared";

import { ask } from "../agent/agent.js";
import { db, withTenant } from "../db/postgres.js";
import { conversations, messages } from "../db/schema.js";
import { getLatestScan } from "../db/repository.js";
import { requireGraphScope } from "../tenancy/graphScope.js";
import type { ConversationId } from "../tenancy/ids.js";
import type { Scope } from "../tenancy/scope.js";

@Injectable()
export class ChatService {
  /**
   * The scan the answer will be grounded in.
   *
   * Answering from an empty graph produces confident nonsense, so it is
   * refused with something the UI can act on rather than attempted. Resolved
   * before the stream opens, so the refusal can be a status code.
   */
  async requireScan(scope: Scope) {
    const latest = await getLatestScan(scope);
    if (!latest) {
      throw new ConflictException({
        error: "No scan has completed yet. Run a scan before asking questions.",
        code: "NO_SCAN",
      });
    }
    return latest;
  }

  async answer(params: {
    scope: Scope;
    question: string;
    history?: { role: "user" | "assistant"; content: string }[];
    onEvent: (event: AgentEvent) => void;
  }) {
    // `require`, not `graphScopeFor`: an empty graph would have the agent tell
    // a customer their account contains nothing, which is worse than a refusal.
    const graph = await requireGraphScope(params.scope);
    return ask({
      tools: { scope: params.scope, graph },
      question: params.question,
      history: params.history ?? [],
      onEvent: params.onEvent,
    });
  }

  /** The full audit trail: which tools ran, what was cited, what was flagged. */
  async record(params: {
    scope: Scope;
    conversationId: string;
    accountId: string;
    scanId: string;
    question: string;
    message: AgentMessage;
  }) {
    return withTenant(params.scope.tenantId, async () => {
      await db
        .insert(conversations)
        .values({
          id: params.conversationId,
          tenantId: params.scope.tenantId,
          connectionId: params.scope.connectionId,
          accountId: params.accountId,
        })
        .onConflictDoNothing();
      await db.insert(messages).values([
        {
          id: randomUUID(),
          tenantId: params.scope.tenantId,
          conversationId: params.conversationId,
          role: "user",
          content: params.question,
          scanId: params.scanId,
        },
        {
          id: params.message.id,
          tenantId: params.scope.tenantId,
          conversationId: params.conversationId,
          role: "assistant",
          content: params.message.content,
          toolCalls: params.message.toolCalls ?? [],
          citations: params.message.citations ?? [],
          warnings: params.message.warnings ?? [],
          scanId: params.scanId,
        },
      ]);
    });
  }

  async conversation(scope: Scope, id: ConversationId) {
    return withTenant(scope.tenantId, async () => {
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
        // Scoped as well as keyed: a conversation id is a uuid, which is an
        // argument for convenience and not for access control.
        .where(and(eq(messages.conversationId, id), eq(messages.tenantId, scope.tenantId)))
        .orderBy(asc(messages.createdAt));

      return { messages: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })) };
    });
  }
}
