/**
 * Is something answering `/api/health` at this URL?
 *
 * Its own module so the setup script's three-way restart decision - container,
 * host, or nothing running - can be tested. Never throws: an unreachable API is
 * a normal state during setup.
 */
export async function apiReachable(url: string, timeoutMs = 2500): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    // Connection refused, DNS failure, timeout - all mean "not running".
    return false;
  }
}
