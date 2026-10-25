/**
 * A scan declined by a limit rather than by the queue.
 *
 * Separate from `ScanAlreadyQueued` because the two mean different things to
 * the person who pressed the button: that one says "the scan you want is
 * already happening, here it is", and the UI attaches to it. This one says "not
 * yet", and sometimes says when.
 *
 * Its own file so the controller can catch it without importing the limits
 * module, which would drag a database query into a file whose job is HTTP.
 */

import { requestsRefused } from "../../observability/metrics.js";
import { statusFor, type Decision } from "../../tenancy/limits.js";

export class ScanRefused extends Error {
  readonly retryAfterSeconds: number | undefined;
  /** 429 when the caller's own usage caught up, 503 when an operator paused it. */
  readonly status: 429 | 503;

  constructor(decision: Extract<Decision, { allowed: false }>) {
    super(decision.reason);
    this.name = "ScanRefused";
    this.retryAfterSeconds = decision.retryAfterSeconds;
    this.status = statusFor(decision.kind);
    // Counted here because constructing this *is* the refusal - one per
    // request turned away, rather than one per limit evaluated.
    requestsRefused.inc({ kind: decision.kind, what: "scan" });
  }
}
