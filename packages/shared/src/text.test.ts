import { describe, expect, it } from "vitest";

import { asText, errorMessage } from "./text.js";

describe("errorMessage", () => {
  it("reads the message off an Error", () => {
    expect(errorMessage(new Error("role not assumable"))).toBe("role not assumable");
  });

  it("stringifies what is not an Error, because throw accepts any value", () => {
    expect(errorMessage("plain string")).toBe("plain string");
    expect(errorMessage(404)).toBe("404");
  });

  /**
   * The bug this helper was extracted to fix.
   *
   * Three call sites interpolated the raw value on the fallback branch, so a
   * thrown object reached the log as `[object Object]` - the one rendering that
   * tells the reader nothing at all.
   */
  it("never yields [object Object] for a thrown object", () => {
    expect(errorMessage({ code: "AccessDenied" })).not.toContain("[object Object]");
    expect(errorMessage({ code: "AccessDenied" })).toBe('{"code":"AccessDenied"}');
  });

  it("names the absent cases rather than returning an empty message", () => {
    expect(errorMessage(null)).toBe("null");
    expect(errorMessage(undefined)).toBe("undefined");
  });

  it("keeps a subclass's message", () => {
    class TimeoutError extends Error {}
    expect(errorMessage(new TimeoutError("timed out"))).toBe("timed out");
  });

  /**
   * The real failure this branch was added for.
   *
   * Node throws exactly this when a dual-stack connect exhausts every address,
   * and a scan unit reported it as `Failed to read secretsmanager in
   * ap-southeast-1:` - a sentence that stops at the colon, because the detail
   * is in `errors` and `message` is empty.
   */
  it("reaches into an AggregateError, whose own message is empty", () => {
    const err = new AggregateError([
      new Error("connect ENETUNREACH 2406:da18:141:ab02::1:443"),
      new Error("connect ETIMEDOUT 52.221.68.114:443"),
    ]);
    expect(err.message).toBe("");
    expect(errorMessage(err)).toBe("connect ENETUNREACH 2406:da18:141:ab02::1:443");
  });

  it("skips an inner error that has nothing to say", () => {
    const err = new AggregateError([new Error(""), new Error("connect ETIMEDOUT")]);
    expect(errorMessage(err)).toBe("connect ETIMEDOUT");
  });

  it("names an empty Error rather than returning an empty string", () => {
    expect(errorMessage(new Error(""))).toBe("Error");
    expect(errorMessage(new AggregateError([]))).toBe("AggregateError");
    class TimeoutError extends Error {
      override name = "TimeoutError";
    }
    expect(errorMessage(new TimeoutError(""))).toBe("TimeoutError");
  });
});

describe("asText", () => {
  it("passes a string through untouched", () => {
    expect(asText("gp3")).toBe("gp3");
  });

  it("renders an object as JSON rather than [object Object]", () => {
    expect(asText({ BlockPublicAcls: true })).toBe('{"BlockPublicAcls":true}');
  });

  it("renders an array as JSON", () => {
    expect(asText(["80", "443"])).toBe('["80","443"]');
  });

  it('is empty for the absent cases, which every call site spelled as ?? ""', () => {
    expect(asText(null)).toBe("");
    expect(asText(undefined)).toBe("");
  });

  it("keeps numbers and booleans readable", () => {
    expect(asText(0)).toBe("0");
    expect(asText(false)).toBe("false");
  });
});
