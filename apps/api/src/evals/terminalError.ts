/**
 * Whether an API error will recur for every remaining eval case.
 *
 * Its own module rather than a helper inside `cli/evals.ts`, because that file
 * is a script with top-level await: importing it to test a predicate would run
 * the entire eval suite and spend money doing it.
 */

/**
 * A spend cap, an exhausted quota or a rejected key does not get better by
 * trying the next question. Continuing turns one billing event into a page of
 * identical red and - the real damage - produces a *plausible* score: the run
 * that prompted this reported "17/21, mean F1 0.81", which reads as an agent
 * that regressed rather than an account that ran out of credit.
 *
 * Matched on message text, not status code. Anthropic returns the usage-limit
 * refusal as `400 invalid_request_error`, which by code alone is
 * indistinguishable from a genuinely malformed request - and those two need
 * opposite responses: stop the run, versus fix the call.
 */
export function isTerminalApiError(message: string): boolean {
  return /usage limits?|credit balance|quota|rate_?limit|authentication_error|invalid x-api-key|permission_error|insufficient_quota/i.test(
    message,
  );
}
