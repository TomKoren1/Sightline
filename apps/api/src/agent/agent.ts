/**
 * The agent loop: ask the model, run the tools it asked for, repeat until it
 * answers in prose. The loop is the AI SDK's; what matters is what wraps it.
 *
 * The hand-written loop was replaced once it was clear that owning the loop was
 * not the only way to keep the citation ledger exact. `execute` below is this
 * file's own function - it records into the tracker where the rows are produced,
 * so nothing mediates the results. The two load-bearing parts are unchanged:
 * the ledger, and `enforceReadOnlyNotice` on the single exit path (ADR-005,
 * ADR-006, ADR-018).
 *
 * Every step is emitted as an event, so the UI can name the running tool rather
 * than show a spinner.
 */

import { randomUUID } from "node:crypto";
import { createAnthropic } from "@ai-sdk/anthropic";
import { jsonSchema, stepCountIs, streamText, tool, type LanguageModel, type ToolSet } from "ai";
import type { AgentEvent, AgentMessage, ToolCallTrace } from "@sightline/shared";

import { cfg } from "../config.js";
import { getLatestScan } from "../db/repository.js";
import { summariseAccount } from "../db/queries.js";
import { CitationTracker, validateCitations } from "./citations.js";
import { buildSystemPrompt } from "./prompt.js";
import { TOOL_DEFINITIONS, runTool } from "./tools.js";
import { enforceReadOnlyNotice } from "./readOnlyGuard.js";
import { errorMessage } from "@sightline/shared";

/**
 * Cap the loop. Every step is a model call, so a model that keeps asking for
 * tools without concluding is both slow and expensive. Eight is generous for
 * the questions this answers; hitting it is a signal something is wrong.
 */
const MAX_STEPS = 8;

/** Results are truncated before going back to the model, to bound context. */
const MAX_RESULT_CHARS = 12_000;

function configuredModel(): LanguageModel {
  if (!cfg.ANTHROPIC_API_KEY || cfg.ANTHROPIC_API_KEY === "replace-me") {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Add it to .env - see the README for where to get one.",
    );
  }
  return createAnthropic({ apiKey: cfg.ANTHROPIC_API_KEY })(cfg.ANTHROPIC_MODEL);
}

export interface AskOptions {
  question: string;
  /** Prior turns, so follow-up questions work. */
  history?: { role: "user" | "assistant"; content: string }[];
  onEvent?: (event: AgentEvent) => void;
  /**
   * The language model, defaulting to the configured one.
   *
   * Injectable so the citation ledger and the read-only guard can be tested
   * against a scripted model rather than against the real one — those are
   * properties that must hold for *any* model output, including output no
   * prompt would reliably produce, such as an answer naming a resource no tool
   * returned.
   */
  model?: LanguageModel;
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

/**
 * The curated tools, in the shape the SDK wants.
 *
 * Built from `TOOL_DEFINITIONS` rather than redeclared, so the tool boundary
 * stays defined in one place and `toolLabels.test.ts` keeps comparing the same
 * list the model is given. The JSON schemas are handed over verbatim through
 * `jsonSchema()` — rewriting sixteen of them into Zod would have been sixteen
 * opportunities to change what the model is allowed to pass.
 */
function buildTools(ctx: {
  tracker: CitationTracker;
  traces: ToolCallTrace[];
  emit: (event: AgentEvent) => void;
}): ToolSet {
  return Object.fromEntries(
    TOOL_DEFINITIONS.map((definition) => [
      definition.name,
      tool({
        description: definition.description,
        inputSchema: jsonSchema(definition.input_schema),

        async execute(rawInput, { toolCallId }) {
          const input = (rawInput ?? {}) as Record<string, never>;
          ctx.emit({ type: "agent.tool_call", name: definition.name, input });

          const startedAt = Date.now();
          try {
            const result = await runTool(definition.name, input);

            /**
             * The ledger, recorded here rather than in a framework callback.
             *
             * This is the line the whole citation mechanism rests on: after the
             * model answers, every ARN it names is checked against what these
             * calls returned, and anything unsupported is flagged to the user.
             * It is inside `execute` because `execute` is ours — the rows go
             * into the tracker before they go anywhere else, including back to
             * the model.
             */
            ctx.tracker.record(result.rows, result.arns);

            const durationMs = Date.now() - startedAt;
            ctx.traces.push({
              id: toolCallId,
              name: definition.name,
              input,
              resultCount: result.rows.length,
              arns: result.arns,
              durationMs,
              ...(result.query ? { query: result.query } : {}),
            });
            ctx.emit({
              type: "agent.tool_result",
              name: definition.name,
              resultCount: result.rows.length,
              durationMs,
            });
            return serialiseResult(result);
          } catch (err) {
            // Returned rather than thrown: the model can often recover by
            // trying a different tool, and failing the step would end the turn
            // with nothing to show the user.
            const message = errorMessage(err);
            const durationMs = Date.now() - startedAt;
            ctx.traces.push({
              id: toolCallId,
              name: definition.name,
              input,
              resultCount: 0,
              arns: [],
              durationMs,
              error: message,
            });
            ctx.emit({
              type: "agent.tool_result",
              name: definition.name,
              resultCount: 0,
              durationMs,
              error: message,
            });
            return `Tool failed: ${message}`;
          }
        },
      }),
    ]),
  );
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

  const tracker = new CitationTracker();
  const toolCalls: ToolCallTrace[] = [];
  let answer = "";

  const result = streamText({
    model: options.model ?? configuredModel(),
    system,
    messages: [
      ...history.map((h) => ({ role: h.role, content: h.content })),
      {
        role: "user" as const,
        content: question,
      },
    ],
    tools: buildTools({ tracker, traces: toolCalls, emit }),
    stopWhen: stepCountIs(MAX_STEPS),

    onStepEnd({ text, toolCalls: calls }) {
      if (calls.length > 0) {
        // Text alongside tool calls is the model narrating its plan. Worth
        // showing as activity, but it is not the answer.
        if (text.trim()) emit({ type: "agent.thinking", text: text.trim() });
        return;
      }
      answer = text.trim();
    },
  });

  // Draining the stream is what runs the loop. Tokens are emitted as they
  // arrive, including during tool-calling steps, which is what it did before.
  for await (const delta of result.textStream) {
    emit({ type: "agent.token", text: delta });
  }

  if (!answer) {
    answer =
      "I wasn't able to reach a conclusion within the tool-call limit. Try narrowing the question " +
      "to a specific resource or region.";
  }

  /**
   * A request to change something must be answered with an explicit statement
   * that we cannot. The prompt asks for this and the model does not reliably
   * comply, so it is guaranteed here instead - see readOnlyGuard.ts.
   *
   * On the single exit path, deliberately: whatever the loop did, nothing
   * reaches the user without passing through this and the citation check.
   */
  const guarded = enforceReadOnlyNotice(question, answer);

  const { citations, warnings } = validateCitations(
    guarded.content,
    tracker.allowed,
    tracker.known,
  );

  const message: AgentMessage = {
    id: messageId,
    role: "assistant",
    content: guarded.content,
    createdAt: new Date().toISOString(),
    toolCalls,
    citations,
    ...(warnings.length > 0 ? { warnings } : {}),
  };

  emit({ type: "agent.finished", message });
  return message;
}
