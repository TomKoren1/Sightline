/**
 * Credentials this process has seen the guard accept, so the rate limiter can
 * key on them.
 *
 * The limiter runs before authentication, and keying on whatever cookie or
 * token a request carries let anyone send a fresh made-up one each time and
 * get a fresh allowance. Now only a credential the guard has verified earns
 * its own bucket - so people behind one office address are not limited
 * together - and anything else counts against its address. In memory and per
 * replica: a credential is learned on its first request to each.
 */

import { createHash } from "node:crypto";

const MAX_REMEMBERED = 10_000;
const verified = new Map<string, true>();

export const credentialKey = (raw: string): string =>
  createHash("sha256").update(raw).digest("hex").slice(0, 32);

export function markVerified(raw: string): void {
  const key = credentialKey(raw);
  verified.delete(key);
  verified.set(key, true);
  if (verified.size > MAX_REMEMBERED) verified.delete(verified.keys().next().value!);
}

export const isVerified = (key: string): boolean => verified.has(key);
