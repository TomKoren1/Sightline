/** Agent wire types, shared between the API and the UI. */

/** A single tool invocation, surfaced to the user so answers are auditable. */
export interface ToolCallTrace {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** Number of rows the tool returned. */
  resultCount: number;
  /** ARNs the tool returned - the permitted citation set for this turn. */
  arns: string[];
  durationMs: number;
  error?: string;
  /** The Cypher actually executed, for transparency. */
  query?: string;
}

/**
 * An ARN the agent cited, checked against what the tools actually returned.
 *
 * `valid: false` means the model produced an identifier that appeared in no
 * tool result - a hallucination, caught mechanically rather than hoped away.
 */
export interface Citation {
  arn: string;
  valid: boolean;
  kind?: string;
  name?: string;
}

export interface AgentMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  toolCalls?: ToolCallTrace[];
  citations?: Citation[];
  /** Set when citation validation found unsupported ARNs. */
  warnings?: string[];
}

/** Server-sent events emitted while the agent works. */
export type AgentEvent =
  | { type: "agent.started"; messageId: string }
  | { type: "agent.thinking"; text: string }
  | { type: "agent.tool_call"; name: string; input: Record<string, unknown> }
  | {
      type: "agent.tool_result";
      name: string;
      resultCount: number;
      durationMs: number;
      error?: string;
    }
  | { type: "agent.token"; text: string }
  | { type: "agent.finished"; message: AgentMessage }
  | { type: "agent.failed"; error: string };
