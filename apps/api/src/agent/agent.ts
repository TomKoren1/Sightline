/**
 * The agent loop.
 *
 * A straightforward tool-calling loop: ask the model, run whatever tools it
 * asked for, hand the results back, repeat until it answers in prose. No agent
 * framework, because the interesting decisions here are the tool boundary
 * (ADR-005) and citation validation (ADR-006), and a framework would hide
 * both behind its own abstractions without removing any real work.
 *
 * Everything the loop does is emitted as an event, so the UI can show which
 * tool is running rather than a spinner - "what is the agent doing while it
 * works" is one of the things the brief asks for, and a tool name is a far
 * better answer than "Thinking...".
 */

import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";

/**
 * Local aliases for the SDK's content-block types.
 *
 * `Anthropic` is imported as a value (it is the client class), and referring
 * to `Anthropic.TextBlock` in type position inside a type predicate does not
 * resolve - the predicate silently degrades and the callback parameter becomes
 * implicitly `any`. Aliasing them once here keeps the call sites readable and
 * makes the failure impossible to reintroduce quietly.
 */
type TextBlock = Anthropic.Messages.TextBlock;
type ToolUseBlock = Anthropic.Messages.ToolUseBlock;
import type { AgentEvent, AgentMessage, ToolCallTrace } from "@daveio/shared";

import { cfg } from "../config.js";
import { getLatestScan } from "../db/repository.js";
import { summariseAccount } from "../db/queries.js";
import { CitationTracker, validateCitations } from "./citations.js";
import { buildSystemPrompt } from "./prompt.js";
import { TOOL_DEFINITIONS, runTool } from "./tools.js";

/**
 * Cap the loop. Every iteration is a model call, so a model that keeps asking
 * for tools without concluding is both slow and expensive. Eight is generous
 * for the questions this answers; hitting it is a signal something is wrong.
 */
const MAX_ITERATIONS = 8;

/** Results are truncated before going back to the model, to bound context. */
const MAX_RESULT_CHARS = 12_000;

let client: Anthropic | null = null;

function anthropic(): Anthropic {
  if (!cfg.ANTHROPIC_API_KEY || cfg.ANTHROPIC_API_KEY === "replace-me") {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Add it to .env - see the README for where to get one.",
    );
  }
  client ??= new Anthropic({ apiKey: cfg.ANTHROPIC_API_KEY });
  return client;
}

export interface AskOptions {
  question: string;
  /** Prior turns, so follow-up questions work. */
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  onEvent?: (event: AgentEvent) => void;
}

/** Serialise a tool result for the model, truncating rather than blowing context. */
function serialiseResult(result: { rows: unknown[]; note?: string }): string {
  const body = JSON.stringify(result.rows);
  const truncated =
    body.length > MAX_RESULT_CHARS
      ? body.slice(0, MAX_RESULT_CHARS) +
        `\n... truncated. ${result.rows.length} rows returned; narrow the query if you need the rest.`
      : body;
  return result.note ? `${result.note}\n${truncated}` : truncated;
}

export async function ask(options: AskOptions): Promise<AgentMessage> {
  const { question, history = [], onEvent } = options;
  const emit = (event: AgentEvent) => onEvent?.(event);
  const messageId = randomUUID();

  emit({ type: "agent.started", messageId });

  // Freshness and partial-failure context go into the system prompt, so the
  // model can warn about stale or missing data without being asked.
  const [latest, summary] = await Promise.all([
    getLatestScan(),
    summariseAccount().catch(() => null),
  ]);

  const resourceCount = summary?.byKind.reduce((sum, k) => sum + k.count, 0) ?? 0;
  const system = buildSystemPrompt({
    accountId: latest?.accountId ?? "unknown",
    regions: latest?.regions ?? [],
    scannedAt: latest?.startedAt ?? null,
    scanStatus: latest?.status ?? null,
    failedUnits: (latest?.units ?? [])
      .filter((u) => u.status === "failed")
      .map((u) => ({ service: u.service, region: u.region, error: u.error })),
    resourceCount,
  });

  const messages: Anthropic.MessageParam[] = [
    ...history.map((h) => ({ role: h.role, content: h.content }) as Anthropic.MessageParam),
    { role: "user", content: question },
  ];

  const tracker = new CitationTracker();
  const toolCalls: ToolCallTrace[] = [];
  let answer = "";

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const stream = anthropic().messages.stream({
      model: cfg.ANTHROPIC_MODEL,
      max_tokens: 4096,
      system,
      tools: TOOL_DEFINITIONS,
      messages,
    });

    stream.on("text", (delta) => emit({ type: "agent.token", text: delta }));

    const response = await stream.finalMessage();

    const textBlocks = response.content.filter(
      (block): block is TextBlock => block.type === "text",
    );
    const toolUses = response.content.filter(
      (block): block is ToolUseBlock => block.type === "tool_use",
    );

    if (toolUses.length === 0) {
      answer = textBlocks.map((b) => b.text).join("\n").trim();
      break;
    }

    // Text produced alongside tool calls is the model narrating its plan.
    // Worth showing, but it is not the answer.
    for (const block of textBlocks) {
      if (block.text.trim()) emit({ type: "agent.thinking", text: block.text.trim() });
    }

    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      const input = (use.input ?? {}) as Record<string, never>;
      emit({ type: "agent.tool_call", name: use.name, input });

      const startedAt = Date.now();
      let trace: ToolCallTrace;

      try {
        const result = await runTool(use.name, input);
        tracker.record(result.rows, result.arns);
        const durationMs = Date.now() - startedAt;

        trace = {
          id: use.id,
          name: use.name,
          input,
          resultCount: result.rows.length,
          arns: result.arns,
          durationMs,
          ...(result.query ? { query: result.query } : {}),
        };
        emit({
          type: "agent.tool_result",
          name: use.name,
          resultCount: result.rows.length,
          durationMs,
        });
        toolResults.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: serialiseResult(result),
        });
      } catch (err) {
        // Handed back to the model rather than thrown: it can often recover by
        // trying a different tool, and throwing would end the turn with
        // nothing to show the user.
        const message = err instanceof Error ? err.message : String(err);
        const durationMs = Date.now() - startedAt;
        trace = { id: use.id, name: use.name, input, resultCount: 0, arns: [], durationMs, error: message };
        emit({ type: "agent.tool_result", name: use.name, resultCount: 0, durationMs, error: message });
        toolResults.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: `Tool failed: ${message}`,
          is_error: true,
        });
      }

      toolCalls.push(trace);
    }

    messages.push({ role: "user", content: toolResults });
  }

  if (!answer) {
    answer =
      "I wasn't able to reach a conclusion within the tool-call limit. Try narrowing the question " +
      "to a specific resource or region.";
  }

  const { citations, warnings } = validateCitations(answer, tracker.allowed, tracker.known);

  const message: AgentMessage = {
    id: messageId,
    role: "assistant",
    content: answer,
    createdAt: new Date().toISOString(),
    toolCalls,
    citations,
    ...(warnings.length > 0 ? { warnings } : {}),
  };

  emit({ type: "agent.finished", message });
  return message;
}
