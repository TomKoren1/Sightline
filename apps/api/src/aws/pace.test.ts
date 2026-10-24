import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { accountOfRole, pace } from "./pace.js";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** How many of `n` requests have been let through after `ms`. */
async function released(key: string, n: number, rate: number, ms: number) {
  let done = 0;
  for (let i = 0; i < n; i++) void pace(key, rate).then(() => done++);
  await vi.advanceTimersByTimeAsync(ms);
  return done;
}

describe("pace", () => {
  it("lets a burst of up to the rate through at once, then one per interval", async () => {
    expect(await released("a:ec2:us-east-1", 25, 10, 0)).toBe(10);
  });

  it("releases the rest at the rate, in order", async () => {
    expect(await released("b:ec2:us-east-1", 25, 10, 1000)).toBe(20);
    await vi.advanceTimersByTimeAsync(500);
  });

  it("keeps each service and region apart", async () => {
    let iam = 0;
    for (let i = 0; i < 15; i++) void pace("c:ec2:us-east-1", 10);
    for (let i = 0; i < 5; i++) void pace("c:iam:us-east-1", 10).then(() => iam++);
    await vi.advanceTimersByTimeAsync(0);
    expect(iam).toBe(5);
    await vi.advanceTimersByTimeAsync(1000);
  });
});

describe("accountOfRole", () => {
  it("reads the account from a role ARN", () => {
    expect(accountOfRole("arn:aws:iam::123456789012:role/Scanner")).toBe("123456789012");
  });
});
