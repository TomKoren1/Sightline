import { describe, expect, it } from "vitest";
import { runWithConcurrency } from "./limiter.js";

describe("runWithConcurrency", () => {
  it("returns results in task order, not completion order", async () => {
    const tasks = [40, 10, 20].map((delay, i) => async () => {
      await new Promise((r) => setTimeout(r, delay));
      return i;
    });
    expect(await runWithConcurrency(tasks, 3)).toEqual([0, 1, 2]);
  });

  it("never exceeds the concurrency limit", async () => {
    let active = 0;
    let peak = 0;
    const tasks = Array.from({ length: 20 }, () => async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
    await runWithConcurrency(tasks, 4);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it("runs every task even when there are fewer than the limit", async () => {
    const seen: number[] = [];
    await runWithConcurrency(
      [1, 2].map((n) => async () => void seen.push(n)),
      10,
    );
    expect(seen.sort()).toEqual([1, 2]);
  });

  it("handles an empty task list", async () => {
    expect(await runWithConcurrency([], 4)).toEqual([]);
  });
});
