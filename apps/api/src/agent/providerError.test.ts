/**
 * A provider's error reaches the user as that error.
 *
 * The AI SDK's text stream does not throw when the provider refuses a call: it
 * ends. Read as an empty answer, a refused API key was reported as "I wasn't
 * able to reach a conclusion within the tool-call limit", which sends an
 * operator looking at the question instead of the key.
 */

import { describe, expect, it, vi } from "vitest";
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";

import { ask } from "./agent.js";
import { describeAgentFailure } from "./failure.js";
import * as queries from "../db/graph.js";
import * as repository from "../db/repository.js";
import type { ToolContext } from "./tools.js";
import { asConnectionId, asScanId, asTenantId } from "../core/ids.js";

const TOOLS: ToolContext = {
  scope: {
    tenantId: asTenantId("00000000-0000-0000-0000-0000000000aa"),
    connectionId: asConnectionId("00000000-0000-0000-0000-0000000000bb"),
  },
  graph: {
    tenantId: asTenantId("00000000-0000-0000-0000-0000000000aa"),
    scanId: asScanId("00000000-0000-0000-0000-0000000000cc"),
  },
};

const refusedKey = () =>
  new APICallError({
    message: "invalid x-api-key",
    url: "https://api.anthropic.com/v1/messages",
    requestBodyValues: {},
    statusCode: 401,
    responseBody: '{"type":"error","error":{"type":"authentication_error"}}',
    isRetryable: false,
  });

describe("a provider error", () => {
  it("is thrown from ask, not answered as running out of tool calls", async () => {
    // The two database reads ask() makes before calling the model.
    const scan = vi.spyOn(repository, "getLatestScan").mockResolvedValue(null);
    const summary = vi.spyOn(queries, "summariseAccount").mockRejectedValue(new Error("no db"));
    try {
      const model = new MockLanguageModelV4({
        doStream: async () => {
          throw refusedKey();
        },
      });
      const failure = await ask({ tools: TOOLS, question: "what is public?", model }).then(
        () => null,
        (err: unknown) => err,
      );
      expect(failure, "ask() answered instead of failing").not.toBeNull();
      expect(describeAgentFailure(failure)).toMatch(/Anthropic key was refused/);
    } finally {
      scan.mockRestore();
      summary.mockRestore();
    }
  });
});
