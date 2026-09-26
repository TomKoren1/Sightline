/**
 * Chat endpoint.
 *
 * Streams the agent's work as server-sent events. The stream carries more than
 * tokens: every tool call and result goes down it too, so the UI can say
 * "checking network paths to northwind-prod-db" instead of showing a spinner.
 * That is the difference between a user trusting the answer and waiting for it.
 */

import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AgentEvent } from "@daveio/shared";

import { ask } from "../agent/agent.js";
import { tenantOf } from "../tenancy/request.js";
import { pool } from "../db/postgres.js";
import { getLatestScan } from "../db/repository.js";

const askSchema = z.object({
  question: z.string().min(1).max(2000),
  conversationId: z.string().uuid().optional(),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() }))
    .max(20)
    .optional(),
});

export function registerChatRoutes(app: FastifyInstance): void {
  app.post("/api/chat", async (req, reply) => {
    const parsed = askSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid request", details: parsed.error.flatten() });
    }
    const tenantId = tenantOf(req);
    const { question, history } = parsed.data;

    // Answering from an empty graph produces confident nonsense, so it is
    // refused with something the UI can act on rather than attempted.
    const latest = await getLatestScan(tenantId);
    if (!latest) {
      return reply.code(409).send({
        error: "No scan has completed yet. Run a scan before asking questions.",
        code: "NO_SCAN",
      });
    }

    const conversationId = parsed.data.conversationId ?? randomUUID();

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const send = (event: AgentEvent) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);

    try {
      const message = await ask({ tenantId, question, history: history ?? [], onEvent: send });

      // Persisted after the fact, including the full audit trail. A failure to
      // persist must not lose the answer the user is already reading.
      try {
        await pool.query(
          `INSERT INTO conversations (id, account_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [conversationId, latest.accountId],
        );
        await pool.query(
          `INSERT INTO messages (id, conversation_id, role, content, scan_id) VALUES ($1,$2,'user',$3,$4)`,
          [randomUUID(), conversationId, question, latest.id],
        );
        await pool.query(
          `INSERT INTO messages (id, conversation_id, role, content, tool_calls, citations, warnings, scan_id)
           VALUES ($1,$2,'assistant',$3,$4,$5,$6,$7)`,
          [
            message.id,
            conversationId,
            message.content,
            JSON.stringify(message.toolCalls ?? []),
            JSON.stringify(message.citations ?? []),
            JSON.stringify(message.warnings ?? []),
            latest.id,
          ],
        );
      } catch (err) {
        req.log.error({ err }, "failed to persist conversation");
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      req.log.error({ err }, "agent failed");
      send({ type: "agent.failed", error: text });
    } finally {
      reply.raw.end();
    }
  });

  app.get<{ Params: { id: string } }>("/api/conversations/:id", async (req) => {
    const { rows } = await pool.query(
      `SELECT id, role, content, tool_calls, citations, warnings, created_at
         FROM messages WHERE conversation_id = $1 ORDER BY created_at`,
      [req.params.id],
    );
    return {
      messages: rows.map((r) => ({
        id: r.id,
        role: r.role,
        content: r.content,
        toolCalls: r.tool_calls,
        citations: r.citations,
        warnings: r.warnings,
        createdAt: r.created_at.toISOString(),
      })),
    };
  });
}
