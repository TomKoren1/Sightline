import { APICallError, RetryError } from "ai";
import { describe, expect, it } from "vitest";

import { describeAgentFailure } from "./failure.js";

const apiError = (statusCode: number, message = "boom") =>
  new APICallError({
    message,
    url: "https://api.anthropic.com/v1/messages",
    requestBodyValues: {},
    statusCode,
  });

const retried = (last: unknown) =>
  new RetryError({
    message: "Failed after 5 attempts",
    reason: "maxRetriesExceeded",
    errors: [last],
  });

describe("describeAgentFailure", () => {
  it("says an overloaded provider is temporary and the rest still works", () => {
    const text = describeAgentFailure(retried(apiError(529, "Overloaded")));
    expect(text).toMatch(/overloaded or unavailable right now \(HTTP 529\)/);
    expect(text).toMatch(/findings, the graph and search/);
    expect(text).not.toMatch(/AI_RetryError/);
  });

  it("treats rate limits and server errors the same way", () => {
    expect(describeAgentFailure(apiError(429))).toMatch(/HTTP 429/);
    expect(describeAgentFailure(apiError(503))).toMatch(/HTTP 503/);
  });

  it("points an operator at the key when it is refused", () => {
    expect(describeAgentFailure(apiError(401, "invalid x-api-key"))).toMatch(/ANTHROPIC_API_KEY/);
  });

  it("names exhausted credit rather than calling it an outage", () => {
    const text = describeAgentFailure(apiError(400, "Your credit balance is too low"));
    expect(text).toMatch(/out of model credit/);
  });

  it("passes anything else through", () => {
    expect(describeAgentFailure(new Error("tool exploded"))).toBe(
      "The assistant could not answer: tool exploded",
    );
  });
});
