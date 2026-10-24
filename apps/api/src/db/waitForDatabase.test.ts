/** Waiting for Postgres at startup: out the transient failures, never the real ones. */

import { describe, expect, it, vi } from "vitest";

import { waitForDatabase } from "./postgres.js";

const failure = (code: string) => Object.assign(new Error(code), { code });

describe("waitForDatabase", () => {
  it("waits while the name does not resolve yet, then returns", async () => {
    const probe = vi
      .fn()
      // As Drizzle throws it: the driver's error as the cause.
      .mockRejectedValueOnce(
        Object.assign(new Error("Failed query"), { cause: failure("ENOTFOUND") }),
      )
      .mockRejectedValueOnce(failure("ECONNREFUSED"))
      .mockResolvedValue(undefined);
    const log = vi.fn();
    await waitForDatabase({ timeoutMs: 10_000, log }, probe);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(log.mock.calls[0]![0]).toMatch(/not reachable yet \(ENOTFOUND\)/);
  });

  it("throws a wrong password at once", async () => {
    const probe = vi.fn().mockRejectedValue(failure("28P01"));
    await expect(waitForDatabase({ timeoutMs: 10_000, log: vi.fn() }, probe)).rejects.toThrow(
      "28P01",
    );
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("gives up at the deadline with the last error", async () => {
    const probe = vi.fn().mockRejectedValue(failure("ENOTFOUND"));
    await expect(waitForDatabase({ timeoutMs: 1_000, log: vi.fn() }, probe)).rejects.toThrow(
      "ENOTFOUND",
    );
  });
});
