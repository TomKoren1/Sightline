/**
 * The one configuration decision that can fabricate an inventory.
 *
 * In mock mode every AWS call goes to moto, and the account id written to
 * Postgres comes from the role ARN. If those two disagree — moto's data, a real
 * account's ARN — the scan persists a complete, confident, entirely fictional
 * inventory of somebody's real AWS account. That is the worst output this
 * system can produce, and it has now happened twice by two different routes:
 * once through a leaked `AWS_ENDPOINT_URL` (engineering log #17) and once
 * through `AWS_MODE=mock` overriding a `.env` that pointed at a real account
 * (engineering log #31).
 *
 * Hence a pure function with a test, rather than a condition inside a module
 * that reads `process.env` at import time and cannot be exercised.
 */

import { describe, expect, it } from "vitest";

import { accountOfArn, honoursConfiguredArnInMock } from "./config.js";

const MOCK_ACCOUNT = "123456789012";
const REAL_ACCOUNT = "672299759593";

describe("accountOfArn", () => {
  it("extracts a twelve-digit account id", () => {
    expect(accountOfArn(`arn:aws:iam::${REAL_ACCOUNT}:role/SightlineReadOnlyRole`)).toBe(
      REAL_ACCOUNT,
    );
  });

  it.each([
    ["no account section", "arn:aws:s3:::northwind-public-assets"],
    ["not twelve digits", "arn:aws:iam::12345:role/Foo"],
    ["not an ARN at all", "SightlineReadOnlyRole"],
    ["empty", ""],
  ])("returns null for %s", (_label, arn) => {
    expect(accountOfArn(arn)).toBeNull();
  });
});

describe("honoursConfiguredArnInMock", () => {
  it("honours the onboarding variables when they name the mock account", () => {
    // Engineering log #24: editing these must not appear to do nothing.
    expect(
      honoursConfiguredArnInMock(
        "mock",
        `arn:aws:iam::${MOCK_ACCOUNT}:role/SightlineReadOnlyRole`,
        MOCK_ACCOUNT,
      ),
    ).toBe(true);
  });

  /**
   * The regression. `.env` points at a real account, `AWS_MODE=mock` is
   * overridden on the command line, so `configuredMode` is "mock" while the
   * role ARN still names the real account.
   */
  it("refuses a real account's ARN even when the configured mode is mock", () => {
    expect(
      honoursConfiguredArnInMock(
        "mock",
        `arn:aws:iam::${REAL_ACCOUNT}:role/SightlineReadOnlyRole`,
        MOCK_ACCOUNT,
      ),
      "a real account ARN must never label a scan of the mock",
    ).toBe(false);
  });

  it("respects a non-default MOCK_AWS_ACCOUNT_ID", () => {
    expect(
      honoursConfiguredArnInMock("mock", "arn:aws:iam::999988887777:role/X", "999988887777"),
    ).toBe(true);
    expect(
      honoursConfiguredArnInMock("mock", `arn:aws:iam::${MOCK_ACCOUNT}:role/X`, "999988887777"),
    ).toBe(false);
  });

  it("never honours it when the configured mode is real", () => {
    // Real mode has its own branch; this must not be the one that answers.
    expect(
      honoursConfiguredArnInMock(
        "real",
        `arn:aws:iam::${MOCK_ACCOUNT}:role/SightlineReadOnlyRole`,
        MOCK_ACCOUNT,
      ),
    ).toBe(false);
  });

  it("refuses an unparseable ARN rather than assuming it is the mock", () => {
    expect(honoursConfiguredArnInMock("mock", "not-an-arn", MOCK_ACCOUNT)).toBe(false);
  });
});
