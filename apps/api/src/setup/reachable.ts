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

/**
 * The local API's URL, from a port read out of `.env`.
 *
 * Refused unless it is a port number: interpolated as it stands, a value such
 * as `80@elsewhere.example` would make `localhost` the userinfo and send the
 * request, connection test and all, to another host.
 */
export function localApiUrl(
  name: string,
  port: string | null | undefined,
  fallback: number,
  path: string,
): string {
  const raw = port?.trim() || String(fallback);
  const value = /^\d{1,5}$/.test(raw) ? Number(raw) : NaN;
  if (!(value >= 1 && value <= 65535)) {
    throw new Error(`${name} in .env is "${raw}", which is not a port number (1-65535).`);
  }
  return new URL(path, `http://localhost:${value}`).toString();
}
