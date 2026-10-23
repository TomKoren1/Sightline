/**
 * The client's one path to the API: the headers every request must carry, and
 * the event-stream parser the chat and the scan progress both depend on.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@sightline/shared";

import { askAgent, selectConnection } from "./api.js";

/** A response whose body arrives in the given chunks, split anywhere. */
function streamed(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status });
}

function stubFetch(response: Response) {
  const calls: { path: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", (path: string, init: RequestInit) => {
    calls.push({ path, init });
    return Promise.resolve(response);
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  selectConnection(null);
});

describe("askAgent", () => {
  it("reassembles events split across chunks, and skips a malformed one", async () => {
    stubFetch(
      streamed([
        'data: {"type":"agent.conv',
        'ersation","conversationId":"c1"}\n\ndata: {not json}\n\n',
        'data: {"type":"agent.token","text":"hi"}\n\n',
      ]),
    );
    const events: AgentEvent[] = [];
    await askAgent("q", undefined, (e) => events.push(e));
    expect(events).toEqual([
      { type: "agent.conversation", conversationId: "c1" },
      { type: "agent.token", text: "hi" },
    ]);
  });

  it("sends the forgery header and the selected connection on every request", async () => {
    const calls = stubFetch(streamed([]));
    selectConnection("conn-7");
    await askAgent("q", undefined, () => undefined);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["X-Sightline-Request"]).toBe("1");
    expect(headers["X-Sightline-Connection"]).toBe("conn-7");
  });

  it("sends a conversation id, never a transcript", async () => {
    const calls = stubFetch(streamed([]));
    await askAgent("follow-up", "conv-1", () => undefined);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      question: "follow-up",
      conversationId: "conv-1",
    });
  });

  it("surfaces the server's error message rather than a status code", async () => {
    stubFetch(new Response(JSON.stringify({ error: "Run a scan first." }), { status: 409 }));
    await expect(askAgent("q", undefined, () => undefined)).rejects.toThrow("Run a scan first.");
  });
});
