/**
 * An invite link, carried across sign-in.
 *
 * It arrives as `?join=<token>`; signing in leaves the page for the provider
 * and comes back, so the token waits in sessionStorage - this tab only, gone
 * when it closes - and is taken off the address bar at once, so it is not
 * left in history or a screenshot. Storage can be refused (private windows,
 * blocked site data); then the invite is simply not remembered.
 */

const KEY = "sightline.join";

/** Move a `?join=` token from the URL into this tab's storage. */
export function captureJoinToken(): void {
  const url = new URL(window.location.href);
  const token = url.searchParams.get("join");
  if (!token) return;
  try {
    sessionStorage.setItem(KEY, token);
  } catch {
    // Not remembered; the link still works if opened again once signed in.
  }
  url.searchParams.delete("join");
  window.history.replaceState(null, "", url.toString());
}

export function pendingJoin(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function clearJoin(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}
