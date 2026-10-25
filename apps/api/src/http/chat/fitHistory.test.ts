import { describe, expect, it } from "vitest";

import { fitHistory } from "./chat.service.js";

const q = (n: number) => ({ role: "user" as const, content: "q".repeat(n) });
const a = (n: number) => ({ role: "assistant" as const, content: "a".repeat(n) });

describe("fitHistory", () => {
  it("keeps everything that fits", () => {
    expect(fitHistory([q(10), a(10), q(10), a(10)], 100)).toHaveLength(4);
  });

  it("drops the oldest turns past the budget", () => {
    const kept = fitHistory([q(50), a(50), q(20), a(20)], 60);
    expect(kept.map((t) => t.content.length)).toEqual([20, 20]);
  });

  it("never starts on an answer", () => {
    const kept = fitHistory([q(30), a(30), q(10), a(10)], 50);
    expect(kept[0]!.role).toBe("user");
  });

  it("cuts a newest question that alone is over budget", () => {
    const kept = fitHistory([a(10), q(500)], 100);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.content.endsWith("[cut]")).toBe(true);
  });

  it("sends nothing rather than an answer on its own", () => {
    expect(fitHistory([q(10), a(500)], 100)).toEqual([]);
  });
});
