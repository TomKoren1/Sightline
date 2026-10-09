/**
 * Whether a scan is in flight.
 *
 * This was a module-level `let` in the route file. It is the same single flag,
 * but reaching it now means asking the container for it, and that is the whole
 * difference: a module-level mutable is shared by everything in the process
 * with no way to scope it, whereas a provider can be given a narrower lifetime
 * without touching a single caller.
 *
 * That matters because this flag is one of exactly two things standing between
 * this and multi-tenancy — the other is the cached AWS session. Both say
 * "there is one of these per process", which is true today and is the first
 * assumption to break when there is more than one customer. When that happens
 * this becomes request-scoped or keyed by tenant, and `ScansService` does not
 * change.
 *
 * Still single-tenant, and still honest about it: one boolean, not a map.
 */

import { Injectable } from "@nestjs/common";

@Injectable()
export class ScanStateService {
  private running = false;

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Claim the right to run a scan.
   *
   * Returns false if one is already in flight. Test-and-set in one call rather
   * than exposing a setter, so a caller cannot check and claim in two steps
   * and leave a gap between them.
   */
  claim(): boolean {
    if (this.running) return false;
    this.running = true;
    return true;
  }

  release(): void {
    this.running = false;
  }
}
