/**
 * The agent loop: ask the model, run the tools it asked for, repeat until it
 * answers in prose. The loop is the AI SDK's; what matters is what wraps it.
 *
 * The hand-written loop was replaced once it was clear that owning the loop was
 * not the only way to keep the citation ledger exact. `execute` below is this
 * file's own function - it records into the tracker where the rows are produced,
 * so nothing mediates the results. The two load-bearing parts are unchanged:
 * the ledger, and `enforceReadOnlyNotice` on the single exit path.
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
import { summariseAccount } from "../db/graph.js";
import { CitationTracker, validateCitations } from "./citations.js";
import { buildSystemPrompt } from "./prompt.js";
import {
  arnsIn,
  availableTools,
  encodeCursor,
  runTool,
  type ToolContext,
  type ToolResult,
} from "./tools.js";
import { enforceReadOnlyNotice } from "./readOnlyGuard.js";
import { errorMessage } from "@sightline/shared";
import { fitRows, type Fitted } from "./fit.js";
import {
  agentDuration,
  agentQuestions,
  agentReadOnlyNoticeAdded,
  agentSteps,
  agentTokens,
  agentToolCalls,
  agentTruncatedResults,
  agentUnsupportedCitations,
} from "../observability/metrics.js";

/**
 * Cap the loop. Every step is a model call, so a model that keeps asking for
 * tools without concluding is both slow and expensive. Eight is generous for
 * the questions this answers; hitting it is a signal something is wrong.
 */
const MAX_STEPS = 8;

/** Results are fitted to this before going back to the model, to bound context. */
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
  /** Whose account the question is about. No default: see `tenancy/scope.ts`. */
  tools: ToolContext;
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

/** Counts as a line: the largest few, and how many more there are. */
function counts(label: string, entries: { name: string; count: number }[]): string {
  const shown = entries.slice(0, 8).map((e) => `${e.name} ${e.count}`);
  const rest = entries.length - shown.length;
  return `${label}: ${shown.join(", ")}${rest > 0 ? `, and ${rest} more` : ""}.`;
}

/**
 * Where a list tool's rows sit in the whole answer, and how to get the rest.
 * The cursor follows the rows actually shown, not the rows fetched: when the
 * context budget drops some, the next page starts at the first one dropped.
 */
export function pageLine(
  page: NonNullable<ToolResult["page"]>,
  shown: number,
  scanId: string,
): string {
  if (page.total === 0) return "No rows match.";
  const parts = [
    `Rows ${page.offset + 1}-${page.offset + shown} of ${page.total}.`,
    counts(
      "By kind",
      page.byKind.map((k) => ({ name: k.kind, count: k.count })),
    ),
    counts(
      "By region",
      page.byRegion.map((r) => ({ name: r.region ?? "global", count: r.count })),
    ),
  ];
  const next = page.offset + shown;
  if (next < page.total) {
    parts.push(
      `${page.total - next} more: call again with the same arguments and cursor "${encodeCursor(scanId, next)}". ` +
        "For how many, use the counts above rather than paging.",
    );
  }
  return parts.join(" ");
}

/** Serialise a tool result for the model, fitted to the context budget. */
function serialiseResult(result: ToolResult, fitted: Fitted, scanId: string): string {
  const parts = [result.note];
  if (result.page) {
    parts.push(pageLine(result.page, fitted.rows.length, scanId));
    if (fitted.shortened) parts.push("Long values were shortened.");
  }
  parts.push(JSON.stringify(fitted.rows));
  if (fitted.omitted > 0 || fitted.shortened) agentTruncatedResults.inc();
  if (!result.page && (fitted.omitted > 0 || fitted.shortened)) {
    parts.push(
      [
        fitted.omitted > 0 ? `${fitted.omitted} more rows were not shown.` : "",
        fitted.shortened ? "Long values were shortened." : "",
        "Narrow the question - a kind, a region, a name - to see the rest.",
      ]
        .filter(Boolean)
        .join(" "),
    );
  }
  return parts.filter(Boolean).join("\n");
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
  tools: ToolContext;
  tracker: CitationTracker;
  traces: ToolCallTrace[];
  emit: (event: AgentEvent) => void;
}): ToolSet {
  return Object.fromEntries(
    // `availableTools()`, not the whole list: hosted mode does not offer the
    // raw-SQL escape hatch at all (ADR-016), and the dispatch refuses it too.
    availableTools().map((definition) => [
      definition.name,
      tool({
        description: definition.description,
        inputSchema: jsonSchema(definition.input_schema),

        async execute(rawInput, { toolCallId }) {
          const input = (rawInput ?? {}) as Record<string, never>;
          ctx.emit({ type: "agent.tool_call", name: definition.name, input });

          const startedAt = Date.now();
          try {
            const result = await runTool(ctx.tools, definition.name, input);

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
            // Only what the model will see is citable: an ARN from a row that
            // was cut must not validate an answer that happens to name it.
            const fitted = fitRows(result.rows, MAX_RESULT_CHARS);
            const shown =
              fitted.omitted > 0 || fitted.shortened ? arnsIn(fitted.rows) : result.arns;
            ctx.tracker.record(fitted.rows, shown);

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
            return serialiseResult(result, fitted, ctx.tools.graph.scanId);
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
  const { question, history = [], onEvent, tools } = options;
  const emit = (event: AgentEvent) => onEvent?.(event);
  const messageId = randomUUID();

  emit({ type: "agent.started", messageId });

  // Freshness and partial-failure context go into the system prompt, so the
  // model can warn about stale or missing data without being asked.
  const [latest, summary] = await Promise.all([
    getLatestScan(tools.scope),
    summariseAccount(tools.graph).catch(() => null),
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
  const askedAt = Date.now();
  let answer = "";
  let steps = 0;

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
    tools: buildTools({ tools, tracker, traces: toolCalls, emit }),
    stopWhen: stepCountIs(MAX_STEPS),

    onStepEnd({ text, toolCalls: calls }) {
      steps += 1;
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

  /**
   * The loop ran out of steps without concluding.
   *
   * Tracked rather than inferred, because this answer is a fallback string and
   * reporting it as `answered` makes the one outcome worth watching the one
   * outcome the metric hides.
   */
  const ranOut = !answer;
  if (ranOut) {
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
  if (guarded.added) agentReadOnlyNoticeAdded.inc();

  /**
   * What the answer cost and whether it was supportable.
   *
   * `usage` is awaited rather than read from the step: the AI SDK resolves it
   * once the stream is drained, which has happened by here. Tokens are the
   * only direct measure of what a question costs in money.
   */
  try {
    const usage = await result.usage;
    if (usage?.inputTokens) agentTokens.inc({ kind: "input" }, usage.inputTokens);
    if (usage?.outputTokens) agentTokens.inc({ kind: "output" }, usage.outputTokens);
  } catch {
    // A question that answered is not a failure because accounting did not.
  }
  for (const call of toolCalls) agentToolCalls.inc({ tool: call.name });

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

  /**
   * Citations the tools never returned.
   *
   * The closest thing to a hallucination rate this product can honestly
   * measure, and it is already computed per answer for the user's benefit.
   */
  if (warnings.length > 0) agentUnsupportedCitations.inc(warnings.length);
  const outcome = ranOut
    ? "tool_limit"
    : warnings.length > 0
      ? "unsupported_citations"
      : "answered";
  agentQuestions.inc({ outcome });
  agentDuration.observe((Date.now() - askedAt) / 1000);
  agentSteps.observe(steps);

  emit({ type: "agent.finished", message });
  return message;
}
