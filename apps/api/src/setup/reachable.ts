/**
 * Is something answering `/api/health` at this URL?
 *
 * Its own module so the setup script's three-way "how do I restart this" decision
 * can be tested: container running, running on the host, or **not running at all**.
 * That third case matters more than it looks — the script originally told a
 * first-time reader to "stop `npm run dev:api` and start it again" when nothing was
 * running, which is advice about a process that does not exist.
 *
 * Never throws. An unreachable API is a normal state during setup, not an error.
 */
export async function apiReachable(url: string, timeoutMs = 2500): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    // Connection refused, DNS failure, timeout — all mean "not running".
    return false;
  }
}
