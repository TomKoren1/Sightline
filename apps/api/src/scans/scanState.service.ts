/**
 * Which connections have a scan in flight.
 *
 * Was a single boolean, which is honest for one operator and would be a shared
 * surprise for many: one tenant starting a scan would have blocked every other
 * tenant's. Keyed by connection, so two accounts can be scanned at once while a
 * second scan of the *same* account - which would race on the same rows and the
 * same graph scope - still cannot start.
 *
 * In-process, and therefore only correct while there is one API process. The
 * durable version is the `scan_jobs` queue, where the claim is a row and a
 * worker that dies leaves something another can reclaim.
 */

import { Injectable } from "@nestjs/common";

import type { ConnectionId } from "../tenancy/ids.js";

@Injectable()
export class ScanStateService {
  private readonly running = new Set<ConnectionId>();

  isRunning(connectionId: ConnectionId): boolean {
    return this.running.has(connectionId);
  }

  /** Test-and-set in one call, so a caller cannot check and claim with a gap between. */
  claim(connectionId: ConnectionId): boolean {
    if (this.running.has(connectionId)) return false;
    this.running.add(connectionId);
    return true;
  }

  release(connectionId: ConnectionId): void {
    this.running.delete(connectionId);
  }
}
