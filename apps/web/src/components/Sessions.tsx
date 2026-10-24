/** Where you are signed in, and a way to end any of it. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../api.js";

/** "Chrome on Windows" from a user agent, roughly; the raw string otherwise. */
function describeAgent(ua: string | null): string {
  if (!ua) return "Unknown browser";
  const browser = ua.includes("Edg/")
    ? "Edge"
    : ua.includes("Firefox/")
      ? "Firefox"
      : ua.includes("Chrome/")
        ? "Chrome"
        : ua.includes("Safari/")
          ? "Safari"
          : null;
  const os = ua.includes("Windows")
    ? "Windows"
    : ua.includes("Mac OS X")
      ? "macOS"
      : ua.includes("Android")
        ? "Android"
        : /iPhone|iPad/.test(ua)
          ? "iOS"
          : ua.includes("Linux")
            ? "Linux"
            : null;
  return browser && os ? `${browser} on ${os}` : ua.slice(0, 60);
}

export function Sessions() {
  const queryClient = useQueryClient();
  const sessions = useQuery({ queryKey: ["sessions"], queryFn: api.sessions });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["sessions"] });
  const revoke = useMutation({ mutationFn: api.revokeSession, onSuccess: refresh });
  const revokeAll = useMutation({
    mutationFn: api.revokeAllSessions,
    // This one included, so the page is signed out too.
    onSuccess: () => window.location.reload(),
  });
  const rows = sessions.data?.sessions ?? [];
  const failure = revoke.error ?? revokeAll.error ?? sessions.error;

  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <h3 className="flex-1 text-[11px] font-semibold uppercase tracking-wider text-ink-400">
          Your sessions
        </h3>
        {rows.length > 0 && (
          <button
            onClick={() => revokeAll.mutate()}
            disabled={revokeAll.isPending}
            className="rounded border border-ink-700 px-2 py-0.5 text-[11px] text-ink-400 hover:text-danger"
          >
            Sign out everywhere
          </button>
        )}
      </div>
      <ul className="flex flex-col gap-1">
        {rows.map((s) => (
          <li key={s.id} className="flex items-center gap-2 text-[11px] text-ink-400">
            <span className="min-w-0 flex-1 truncate">
              <span className="text-ink-100">{describeAgent(s.userAgent)}</span>
              {s.current && <span className="ml-1.5 text-good">this one</span>}
              {" · "}since {new Date(s.createdAt).toLocaleDateString()}
              {s.lastUsedAt ? ` · active ${new Date(s.lastUsedAt).toLocaleString()}` : ""}
            </span>
            {!s.current && (
              <button
                onClick={() => revoke.mutate(s.id)}
                disabled={revoke.isPending}
                className="rounded border border-ink-700 px-2 py-0.5 text-ink-400 hover:text-danger"
              >
                Sign out
              </button>
            )}
          </li>
        ))}
      </ul>
      {failure && <p className="mt-2 text-[11px] text-danger">{failure.message}</p>}
    </section>
  );
}
