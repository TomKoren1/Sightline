/** Who changed what in this workspace, newest first, and the whole of it as a file. */

import { useInfiniteQuery } from "@tanstack/react-query";

import { api, auditExportUrl, type AuditEntry } from "../api.js";

function describe(entry: AuditEntry): string {
  const status = entry.detail["status"];
  return typeof status === "number" && status >= 400 ? `${entry.action} (${status})` : entry.action;
}

export function AuditLog() {
  const log = useInfiniteQuery({
    queryKey: ["audit"],
    queryFn: ({ pageParam }) => api.audit(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next ?? undefined,
  });

  const entries = log.data?.pages.flatMap((p) => p.entries) ?? [];

  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <h3 className="flex-1 text-[11px] font-semibold uppercase tracking-wider text-ink-400">
          Activity
        </h3>
        {(["csv", "json"] as const).map((format) => (
          <a
            key={format}
            href={auditExportUrl(format)}
            download
            className="rounded border border-ink-700 px-2 py-0.5 text-[11px] text-ink-400 hover:text-ink-100"
          >
            Download {format.toUpperCase()}
          </a>
        ))}
      </div>
      {log.isLoading && <div className="h-20 animate-pulse rounded bg-ink-850" />}
      {log.error && <p className="text-[11px] text-danger">{log.error.message}</p>}
      {log.data && entries.length === 0 && (
        <p className="text-[11px] text-ink-400">Nothing recorded yet.</p>
      )}
      {entries.length > 0 && (
        <ul className="flex max-h-64 flex-col divide-y divide-ink-800 overflow-y-auto rounded border border-ink-800">
          {entries.map((e) => (
            <li key={e.id} className="px-2.5 py-1.5 text-[11px]">
              <p className="truncate font-mono text-ink-100">{describe(e)}</p>
              <p className="truncate text-ink-400">
                {new Date(e.at).toLocaleString()} · {e.actor?.email ?? "Sightline"}
                {e.ip ? ` · ${e.ip}` : ""}
              </p>
            </li>
          ))}
        </ul>
      )}
      {log.hasNextPage && (
        <button
          onClick={() => void log.fetchNextPage()}
          disabled={log.isFetchingNextPage}
          className="mt-2 rounded border border-ink-700 px-2 py-0.5 text-[11px] text-ink-400 hover:text-ink-100"
        >
          Load more
        </button>
      )}
    </section>
  );
}
