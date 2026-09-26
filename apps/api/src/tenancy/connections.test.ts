/**
 * The connection rules that do not need a database.
 *
 * `accountMismatch` is one line and easy to get backwards, and getting it
 * backwards means recording one customer's inventory under another customer's
 * account id - which is engineering log #31, the worst bug this project has
 * had, arriving through a multi-tenant door.
 */

import { describe, expect, it } from "vitest";

import { accountMismatch } from "./connections.js";

describe("the account a connection reaches", () => {
  it("is fine on first verification, when nothing has been agreed yet", () => {
    expect(accountMismatch(null, "672299759593")).toBeNull();
  });

  it("is fine when it matches what was pinned", () => {
    expect(accountMismatch("672299759593", "672299759593")).toBeNull();
  });

  it("is refused when the role now reaches somewhere else", () => {
    const problem = accountMismatch("672299759593", "123456789012");
    expect(problem).toContain("672299759593");
    expect(problem).toContain("123456789012");
    expect(problem).toMatch(/refusing to scan/i);
  });

  /**
   * The direction matters: the message must say which account was agreed and
   * which was reached, because the operator's next action differs entirely
   * depending on which one surprised them.
   */
  it("names the two accounts in the right order", () => {
    const problem = accountMismatch("111111111111", "222222222222")!;
    expect(problem.indexOf("111111111111")).toBeLessThan(problem.indexOf("222222222222"));
  });
});
