/**
 * The citation ledger survives the framework.
 *
 * The agent loop used to be hand-written, and the argument for that was that
 * validating every ARN in an answer means holding the tool results, which
 * means owning the loop. Moving to the AI SDK is a bet that the argument was
 * about *holding* the results rather than about owning the loop — `execute` is
 * this codebase's function, and it records into the tracker at the point the
 * rows are produced.
 *
 * A bet is not a guarantee, so this is the test that settles it. It drives
 * `ask()` with a scripted model that does exactly what no prompt reliably
 * produces: calls a tool, then answers naming a resource that tool never
 * returned. If the ledger is intact the invented ARN is flagged; if anything
 * about the framework's tool handling means a result is missed, a real ARN is
 * flagged instead — and that is the failure that matters, because a product
 * that cries wolf about genuine resources is worse than one with no check.
 *
 * No network, no API key and no databases. The model is a stub and the two
 * reads `ask()` makes for the system prompt are stubbed too, so this runs in
 * the dependency-free job on every commit — which is where a guard on a safety
 * property belongs, and is the reason it is worth stubbing them rather than
 * gating the file behind a database.
 *
 * It did not start that way. The header claimed exactly the above while
 * `getLatestScan()` opened a Postgres connection on the first line of `ask()`,
 * which is invisible on a laptop with the stack running and `ECONNREFUSED` in
 * CI. See engineering log #56.
 */

import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from "@ai-sdk/provider";
import type { AgentEvent } from "@sightline/shared";

import { ask } from "./agent.js";
import * as queries from "../db/queries.js";
import * as repository from "../db/repository.js";
import * as tools from "./tools.js";

const REAL_ARN = "arn:aws:rds:us-east-1:123456789012:db:northwind-prod-db";
const INVENTED_ARN = "arn:aws:rds:us-east-1:123456789012:db:does-not-exist";

/**
 * A model that calls one tool and then answers with the given text.
 *
 * Two responses, because that is the shape of every real turn: a step that
 * asks for a tool, then a step that concludes. The SDK runs the tool between
 * them, which is the part under test.
 */
/** Token counts are irrelevant to these assertions, but the shape is required. */
const NO_USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function scriptedModel(answer: string, toolName = "find_public_resources") {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      call += 1;
      const chunks: LanguageModelV4StreamPart[] =
        call === 1
          ? [
              { type: "stream-start" as const, warnings: [] },
              {
                type: "tool-call" as const,
                toolCallId: "call-1",
                toolName,
                input: JSON.stringify({}),
              },
              {
                type: "finish" as const,
                // v4 carries a unified reason alongside the provider's raw one.
                // As a bare string it parses, the step ends, and the SDK
                // silently declines to run the tool — no error, no result.
                finishReason: { unified: "tool-calls" as const, raw: "tool_use" },
                usage: NO_USAGE,
              },
            ]
          : [
              { type: "stream-start" as const, warnings: [] },
              { type: "text-start" as const, id: "t1" },
              { type: "text-delta" as const, id: "t1", delta: answer },
              { type: "text-end" as const, id: "t1" },
              {
                type: "finish" as const,
                finishReason: { unified: "stop" as const, raw: "end_turn" },
                usage: NO_USAGE,
              },
            ];
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
}

/**
 * The two reads `ask()` makes before it calls the model.
 *
 * They fill in scan freshness and partial-failure context for the system
 * prompt. Neither has anything to do with what is under test here, and both
 * talk to a database, so both are stubbed — otherwise this file silently
 * becomes an integration test.
 */
function stubPromptContext() {
  const scan = vi.spyOn(repository, "getLatestScan").mockResolvedValue({
    id: "11111111-1111-1111-1111-111111111111",
    accountId: "123456789012",
    status: "succeeded",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    regions: ["us-east-1"],
    units: [],
    resourceCount: 1,
    relationshipCount: 0,
  });
  const summary = vi.spyOn(queries, "summariseAccount").mockResolvedValue({
    byKind: [{ kind: "RdsInstance", count: 1 }],
    byRegion: [{ region: "us-east-1", count: 1 }],
    publicCount: 1,
    adminCount: 0,
    idleCount: 0,
    unprotectedCount: 0,
    idleCost: 0,
  });
  return () => {
    scan.mockRestore();
    summary.mockRestore();
  };
}

/** The one tool call returns exactly one real ARN, and nothing else. */
function stubTool() {
  return vi.spyOn(tools, "runTool").mockResolvedValue({
    rows: [{ arn: REAL_ARN, name: "northwind-prod-db", reason: "security group allows 0.0.0.0/0" }],
    arns: [REAL_ARN],
  });
}

async function askWith(answer: string) {
  const events: AgentEvent[] = [];
  const message = await ask({
    question: "what is public?",
    model: scriptedModel(answer),
    onEvent: (e) => events.push(e),
  });
  return { message, events };
}

describe("every ARN in an answer is checked against what the tools returned", () => {
  it("accepts an ARN a tool returned", async () => {
    const spy = stubTool();
    const restoreContext = stubPromptContext();
    try {
      const { message } = await askWith(`The database ${REAL_ARN} is reachable.`);
      expect(message.citations?.map((c) => c.arn)).toContain(REAL_ARN);
      expect(message.citations?.find((c) => c.arn === REAL_ARN)?.valid).toBe(true);
      expect(message.warnings ?? []).toEqual([]);
    } finally {
      spy.mockRestore();
      restoreContext();
    }
  });

  it("flags an ARN no tool returned", async () => {
    const spy = stubTool();
    const restoreContext = stubPromptContext();
    try {
      const { message } = await askWith(`You should look at ${INVENTED_ARN}.`);
      const invented = message.citations?.find((c) => c.arn === INVENTED_ARN);
      expect(invented, "the invented ARN was not cited at all").toBeDefined();
      expect(
        invented!.valid,
        "an ARN that no tool returned was accepted as supported — the ledger is not " +
          "seeing tool results, which is the failure moving to the SDK risked",
      ).toBe(false);
      expect(message.warnings?.length ?? 0).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
      restoreContext();
    }
  });

  it("records the tool call, its result count and the ARNs it returned", async () => {
    const spy = stubTool();
    const restoreContext = stubPromptContext();
    try {
      const { message, events } = await askWith(`${REAL_ARN} is public.`);
      expect(message.toolCalls).toHaveLength(1);
      expect(message.toolCalls![0]!.name).toBe("find_public_resources");
      expect(message.toolCalls![0]!.resultCount).toBe(1);
      expect(message.toolCalls![0]!.arns).toEqual([REAL_ARN]);

      // The UI shows which tool is running rather than a spinner, so these
      // events are a product feature and not only telemetry.
      const kinds = events.map((e) => e.type);
      expect(kinds).toContain("agent.started");
      expect(kinds).toContain("agent.tool_call");
      expect(kinds).toContain("agent.tool_result");
      expect(kinds).toContain("agent.token");
      expect(kinds).toContain("agent.finished");
    } finally {
      spy.mockRestore();
      restoreContext();
    }
  });

  it("hands a tool failure back to the model instead of ending the turn", async () => {
    const spy = vi.spyOn(tools, "runTool").mockRejectedValue(new Error("neo4j is down"));
    const restoreContext = stubPromptContext();
    try {
      const { message } = await askWith("I could not look that up.");
      expect(message.content).toContain("could not look that up");
      expect(message.toolCalls![0]!.error).toBe("neo4j is down");
      expect(message.toolCalls![0]!.resultCount).toBe(0);
    } finally {
      spy.mockRestore();
      restoreContext();
    }
  });
});

describe("the read-only guard still runs on the way out", () => {
  it("adds the refusal to an answer the model gave without one", async () => {
    const spy = stubTool();
    const restoreContext = stubPromptContext();
    try {
      const events: AgentEvent[] = [];
      const message = await ask({
        // A request aimed at the agent to change something. The model is
        // scripted to answer as if it had complied, which is what it really
        // did when this was a prompt instruction rather than code.
        question: "delete the orphaned volume for me",
        model: scriptedModel("Run `aws ec2 delete-volume --volume-id vol-123`."),
        onEvent: (e) => events.push(e),
      });
      expect(
        message.content.toLowerCase(),
        "the guard did not fire, so an answer to a destructive request went out without " +
          "saying Sightline cannot act on the account",
      ).toMatch(/can.?t|cannot/);
    } finally {
      spy.mockRestore();
      restoreContext();
    }
  });
});
