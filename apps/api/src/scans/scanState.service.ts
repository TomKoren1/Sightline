/**
 * Whether a scan is in flight.
 *
 * Was a module-level `let`. Same single flag, but a provider can be given a
 * narrower lifetime without touching a caller - which matters because this and
 * the cached AWS session are the two things standing between this and
 * multi-tenancy. Still one boolean, not a map: single-tenant, and honest.
 */

import { Injectable } from "@nestjs/common";

@Injectable()
export class ScanStateService {
  private running = false;

  get isRunning(): boolean {
    return this.running;
  }

  /** Test-and-set in one call, so a caller cannot check and claim with a gap between. */
  claim(): boolean {
    if (this.running) return false;
    this.running = true;
    return true;
  }

  release(): void {
    this.running = false;
  }
}
