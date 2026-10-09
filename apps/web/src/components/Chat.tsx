/**
 * The chat panel.
 *
 * Two things here are deliberate. While the agent works, the panel names the
 * tool that is running rather than showing a spinner - "what is the agent
 * doing" is a question users ask, and a tool name answers it
 * honestly. And every answer carries an expandable trail of the tool calls
 * behind it, because a DevOps engineer about to act on a finding should be
 * able to see where it came from.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentEvent, Citation, ToolCallTrace } from "@sightline/shared";

import { askAgent } from "../api.js";
import { errorMessage } from "@sightline/shared";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: ToolCallTrace[];
  citations?: Citation[];
  warnings?: string[];
  error?: boolean;
}

/** Plain-language labels; the model's tool names are not user-facing copy. */
const TOOL_LABELS: Record<string, string> = {
  summarise_account: "Summarising the account",
  list_resources: "Listing resources",
  get_resource: "Looking up a resource",
  find_public_resources: "Checking what is publicly reachable",
  find_admin_principals: "Checking for admin privileges",
  find_network_paths: "Tracing network paths",
  find_reachable_from: "Working out blast radius",
  find_instances_in_public_subnets: "Checking subnet placement",
  find_idle_resources: "Looking for idle resources",
  find_unprotected_buckets: "Checking bucket public-access guardrails",
  find_open_security_groups: "Checking security group exposure",
  search_resources: "Searching",
  list_scans: "Checking scan history",
  diff_scans: "Comparing scans",
  suggest_remediation: "Working out how to fix it",
  graph_query: "Running a graph query",
};

const SUGGESTIONS = [
  "Which S3 buckets are public?",
  "What can reach the production RDS instance?",
  "Which IAM roles have admin access, and what uses them?",
  "Is anything costing money but not being used?",
  "Which EC2 instances aren't in a private subnet?",
];

export interface ChatProps {
  /** Disabled until a scan exists; answering from an empty graph is worse than refusing. */
  ready: boolean;
  onCitations: (arns: string[]) => void;
}

export function Chat({ ready, onCitations }: ChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState<string | null>(null);
  const [streamed, setStreamed] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, streamed, activity]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const send = useCallback(
    async (question: string) => {
      if (!question.trim() || busy) return;

      const history = messages
        .filter((m) => !m.error)
        .slice(-8)
        .map((m) => ({ role: m.role, content: m.content }));

      setMessages((prev) => [...prev, { id: `u-${Date.now()}`, role: "user", content: question }]);
      setInput("");
      setBusy(true);
      setStreamed("");
      setActivity("Thinking");
      onCitations([]);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        await askAgent(
          question,
          history,
          (event: AgentEvent) => {
            switch (event.type) {
              case "agent.tool_call":
                setActivity(TOOL_LABELS[event.name] ?? `Running ${event.name}`);
                break;
              case "agent.token":
                // Tokens arrive during tool-calling turns too; showing them
                // then would flash partial reasoning that is not the answer.
                setStreamed((prev) => prev + event.text);
                break;
              case "agent.thinking":
                setActivity(event.text.slice(0, 120));
                break;
              case "agent.finished":
                setMessages((prev) => [
                  ...prev,
                  {
                    id: event.message.id,
                    role: "assistant",
                    content: event.message.content,
                    toolCalls: event.message.toolCalls,
                    citations: event.message.citations,
                    warnings: event.message.warnings,
                  },
                ]);
                onCitations(
                  (event.message.citations ?? []).filter((c) => c.valid).map((c) => c.arn),
                );
                setStreamed("");
                break;
              case "agent.failed":
                setMessages((prev) => [
                  ...prev,
                  { id: `e-${Date.now()}`, role: "assistant", content: event.error, error: true },
                ]);
                setStreamed("");
                break;
              default:
                break;
            }
          },
          controller.signal,
        );
      } catch (err) {
        if (!controller.signal.aborted) {
          setMessages((prev) => [
            ...prev,
            {
              id: `e-${Date.now()}`,
              role: "assistant",
              content: errorMessage(err),
              error: true,
            },
          ]);
        }
      } finally {
        setBusy(false);
        setActivity(null);
        setStreamed("");
        abortRef.current = null;
      }
    },
    [busy, messages, onCitations],
  );

  return (
    <div className="flex h-full flex-col bg-ink-900">
      <header className="flex items-center justify-between border-b border-ink-800 px-3 py-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">
          Ask Sightline
        </h2>
        {messages.length > 0 && (
          <button
            onClick={() => {
              setMessages([]);
              onCitations([]);
            }}
            className="text-[11px] text-ink-400 hover:text-ink-100"
          >
            Clear
          </button>
        )}
      </header>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-3">
        {messages.length === 0 && (
          <div className="space-y-3 pt-2">
            <p className="text-[12px] leading-relaxed text-ink-400">
              Ask about the account in plain language. Answers are grounded in the last scan, and
              every resource mentioned is highlighted in the graph.
            </p>
            <div className="space-y-1.5">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  disabled={!ready}
                  onClick={() => void send(s)}
                  className="block w-full rounded border border-ink-800 bg-ink-850 px-2.5 py-1.5 text-left text-[12px] text-ink-300 transition hover:border-ink-600 hover:text-ink-100 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {s}
                </button>
              ))}
            </div>
            {!ready && (
              <p className="text-[11px] text-warn">
                Run a scan first — there is nothing to answer from yet.
              </p>
            )}
          </div>
        )}

        {messages.map((message) => (
          <MessageBubble
            key={message.id}
            message={message}
            expanded={expanded.has(message.id)}
            onToggle={() =>
              setExpanded((prev) => {
                const next = new Set(prev);
                if (next.has(message.id)) next.delete(message.id);
                else next.add(message.id);
                return next;
              })
            }
            onCite={(arn) => onCitations([arn])}
          />
        ))}

        {busy && (
          <div className="rounded border border-ink-800 bg-ink-850 px-2.5 py-2">
            <div className="flex items-center gap-2">
              <span className="pulse h-1.5 w-1.5 rounded-full bg-accent" />
              <span className="text-[12px] text-ink-300">{activity ?? "Thinking"}…</span>
            </div>
            {streamed && (
              <p className="mt-1.5 whitespace-pre-wrap text-[12px] leading-relaxed text-ink-400">
                {streamed}
              </p>
            )}
          </div>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
        className="border-t border-ink-800 p-2.5"
      >
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={!ready || busy}
            placeholder={ready ? "Ask about this account…" : "Run a scan first"}
            className="flex-1 rounded border border-ink-700 bg-ink-850 px-2.5 py-1.5 text-[12px] text-ink-100 placeholder:text-ink-400 focus:border-accent focus:outline-none disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={!ready || busy || !input.trim()}
            className="rounded bg-accent px-3 py-1.5 text-[12px] font-medium text-ink-950 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-35"
          >
            Ask
          </button>
        </div>
      </form>
    </div>
  );
}

function MessageBubble({
  message,
  expanded,
  onToggle,
  onCite,
}: {
  message: ChatMessage;
  expanded: boolean;
  onToggle: () => void;
  onCite: (arn: string) => void;
}) {
  if (message.role === "user") {
    return (
      <div className="ml-6 rounded border border-ink-700 bg-ink-800 px-2.5 py-1.5">
        <p className="text-[12px] text-ink-100">{message.content}</p>
      </div>
    );
  }

  const valid = (message.citations ?? []).filter((c) => c.valid);

  return (
    <div
      className={`rounded border px-2.5 py-2 ${
        message.error ? "border-danger/40 bg-danger/5" : "border-ink-800 bg-ink-850"
      }`}
    >
      <p
        className={`whitespace-pre-wrap text-[12px] leading-relaxed ${
          message.error ? "text-danger" : "text-ink-100"
        }`}
      >
        {message.content}
      </p>

      {/*
        Unsupported citations are surfaced to the user, not just logged. If the
        model invents an identifier, the person about to act on it should be
        the first to know.
      */}
      {message.warnings?.map((warning) => (
        <p key={warning} className="mt-1.5 rounded bg-warn/10 px-2 py-1 text-[11px] text-warn">
          ⚠ {warning}
        </p>
      ))}

      {valid.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {valid.map((citation) => (
            <button
              key={citation.arn}
              onClick={() => onCite(citation.arn)}
              title={citation.arn}
              className="rounded border border-ink-700 bg-ink-800 px-1.5 py-0.5 text-[10px] text-ink-300 transition hover:border-accent hover:text-accent"
            >
              {citation.name ?? citation.arn.split(/[:/]/).pop()}
            </button>
          ))}
        </div>
      )}

      {message.toolCalls && message.toolCalls.length > 0 && (
        <div className="mt-2 border-t border-ink-800 pt-1.5">
          <button
            onClick={onToggle}
            className="text-[10px] text-ink-400 transition hover:text-ink-300"
          >
            {expanded ? "▾" : "▸"} {message.toolCalls.length} tool call
            {message.toolCalls.length === 1 ? "" : "s"}
          </button>
          {expanded && (
            <div className="mt-1.5 space-y-1">
              {message.toolCalls.map((call) => (
                <div key={call.id} className="rounded bg-ink-900 px-2 py-1 font-mono text-[10px]">
                  <div className="flex items-center justify-between gap-2">
                    <span className={call.error ? "text-danger" : "text-accent"}>{call.name}</span>
                    <span className="shrink-0 text-ink-400">
                      {call.error ? "failed" : `${call.resultCount} rows`} · {call.durationMs}ms
                    </span>
                  </div>
                  {Object.keys(call.input).length > 0 && (
                    <div
                      className="mt-0.5 truncate text-ink-400"
                      title={JSON.stringify(call.input)}
                    >
                      {JSON.stringify(call.input)}
                    </div>
                  )}
                  {call.query && (
                    <div className="mt-0.5 whitespace-pre-wrap text-ink-400">{call.query}</div>
                  )}
                  {call.error && <div className="mt-0.5 text-danger">{call.error}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
