/**
 * What to tell someone whose question the model provider failed to answer.
 *
 * The raw error is a stack of SDK wrappers - "AI_RetryError: Failed after 5
 * attempts. Last error: Overloaded" - which says nothing a user can act on and
 * never mentions that everything else still works. The findings, the graph
 * and search are computed without the model, so the message says so.
 */

import { APICallError, RetryError } from "ai";

import { errorMessage } from "@sightline/shared";

const STILL_WORKS = "The findings, the graph and search do not use it and are unaffected.";

/** The provider's HTTP status, through any retry wrapper. */
function statusOf(err: unknown): number | undefined {
  if (RetryError.isInstance(err)) return statusOf(err.lastError);
  if (APICallError.isInstance(err)) return err.statusCode;
  return undefined;
}

export function describeAgentFailure(err: unknown): string {
  const status = statusOf(err);
  const text = errorMessage(err);
  if (status === 401 || status === 403 || /x-api-key|authentication_error/i.test(text)) {
    return (
      "The assistant cannot reach its model: this deployment's Anthropic key was refused. " +
      `An operator needs to check ANTHROPIC_API_KEY. ${STILL_WORKS}`
    );
  }
  if (/credit balance|usage limits?|quota/i.test(text)) {
    return (
      "The assistant is out of model credit on this deployment, so it cannot answer until an " +
      `operator tops it up. ${STILL_WORKS}`
    );
  }
  if (status === 429 || status === 529 || (status !== undefined && status >= 500)) {
    return (
      `The assistant's model provider is overloaded or unavailable right now (HTTP ${status}), ` +
      `and kept failing after several retries. Try the question again in a minute. ${STILL_WORKS}`
    );
  }
  return `The assistant could not answer: ${text}`;
}
