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
