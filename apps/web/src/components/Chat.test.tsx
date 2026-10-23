/** @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@sightline/shared";

import { Chat } from "./Chat.js";

const askAgent = vi.fn();
vi.mock("../api.js", () => ({ askAgent: (...args: unknown[]): unknown => askAgent(...args) }));

/** A canned answer: the conversation id, then a finished message. */
function answer(conversationId: string, content: string) {
  return (_q: string, _id: string | undefined, onEvent: (e: AgentEvent) => void) => {
    onEvent({ type: "agent.conversation", conversationId });
    onEvent({
      type: "agent.finished",
      message: {
        id: `m-${content}`,
        role: "assistant",
        content,
        createdAt: "2026-10-23T00:00:00Z",
      },
    });
  };
}

beforeEach(() => {
  askAgent.mockReset();
  // jsdom has no layout, so the panel's auto-scroll has nothing to call.
  Element.prototype.scrollTo = () => undefined;
});
afterEach(cleanup);

async function ask(question: string) {
  const user = userEvent.setup();
  await user.type(screen.getByPlaceholderText("Ask about this account…"), `${question}{Enter}`);
}

describe("Chat", () => {
  it("refuses questions until a scan exists", () => {
    render(<Chat ready={false} onCitations={() => undefined} />);
    expect(screen.getByPlaceholderText<HTMLInputElement>("Run a scan first").disabled).toBe(true);
  });

  it("starts a conversation without an id, then continues it with the server's", async () => {
    askAgent.mockImplementationOnce(answer("conv-1", "first answer"));
    askAgent.mockImplementationOnce(answer("conv-1", "second answer"));
    render(<Chat ready onCitations={() => undefined} />);

    await ask("is anything public?");
    expect(await screen.findByText("first answer")).toBeTruthy();
    expect(askAgent.mock.calls[0]![1]).toBeUndefined();

    await ask("and which of those cost money?");
    expect(await screen.findByText("second answer")).toBeTruthy();
    // The id, never a transcript: history is the server's to read.
    expect(askAgent.mock.calls[1]![1]).toBe("conv-1");
  });

  it("forgets the conversation when cleared", async () => {
    askAgent.mockImplementation(answer("conv-1", "an answer"));
    render(<Chat ready onCitations={() => undefined} />);

    await ask("first");
    await screen.findByText("an answer");
    await userEvent.setup().click(screen.getByRole("button", { name: "Clear" }));
    await ask("second");
    expect(askAgent.mock.calls.at(-1)![1]).toBeUndefined();
  });

  it("shows a failure as a message rather than losing it", async () => {
    askAgent.mockImplementationOnce(
      (_q: string, _id: string | undefined, onEvent: (e: AgentEvent) => void) => {
        onEvent({ type: "agent.failed", error: "The model is unavailable." });
        return Promise.resolve();
      },
    );
    render(<Chat ready onCitations={() => undefined} />);
    await ask("anything");
    expect(await screen.findByText("The model is unavailable.")).toBeTruthy();
  });
});
