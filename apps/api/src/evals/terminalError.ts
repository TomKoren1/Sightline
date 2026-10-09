/**
 * Whether an API error will recur for every remaining eval case.
 *
 * Its own module rather than a helper in `cli/evals.ts`, because that file has
 * top-level await: importing it to test a predicate would run the whole suite
 * and spend money doing it.
 */

/**
 * Matched on message text, not status code. Anthropic returns the usage-limit
 * refusal as `400 invalid_request_error`, indistinguishable by code from a
 * malformed request - and those need opposite responses. Continuing past one
 * produces a plausible score: "17/21, mean F1 0.81" reads as a regressed agent
 * rather than an account out of credit.
 */
export function isTerminalApiError(message: string): boolean {
  return /usage limits?|credit balance|quota|rate_?limit|authentication_error|invalid x-api-key|permission_error|insufficient_quota/i.test(
    message,
  );
}
