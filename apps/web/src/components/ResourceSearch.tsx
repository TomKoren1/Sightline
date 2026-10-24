/**
 * Find a resource by name, ARN or tag, in an account too large to find it by
 * looking. Choosing one opens it and highlights it on the graph.
 */

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { api } from "../api.js";

/** Typing pauses this long before a search is sent, so a word is one request. */
const DEBOUNCE_MS = 250;
const MIN_LENGTH = 2;

export function ResourceSearch({ onPick }: { onPick: (arn: string) => void }) {
  const [text, setText] = useState("");
  const [term, setTerm] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setTerm(text.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const enabled = term.length >= MIN_LENGTH;
  const results = useQuery({
    queryKey: ["search", term],
    queryFn: () => api.search(term),
    enabled,
  });
  const rows = results.data?.results ?? [];

  return (
    <div className="border-b border-ink-800 p-2">
      <input
        type="search"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setText("");
          if (e.key === "Enter" && rows[0]) onPick(rows[0].arn);
        }}
        placeholder="Find a resource: name, ARN or tag"
        aria-label="Find a resource"
        className="w-full rounded border border-ink-700 bg-ink-850 px-2 py-1 text-[12px] text-ink-100 placeholder:text-ink-400 focus:border-ink-600 focus:outline-none"
      />
      {enabled && text.trim().length >= MIN_LENGTH && (
        <div className="mt-1.5 max-h-64 overflow-auto text-[11px]">
          {results.isLoading ? (
            <p className="px-1 text-ink-400">Searching…</p>
          ) : results.error ? (
            <p className="px-1 text-danger">{results.error.message}</p>
          ) : rows.length === 0 ? (
            <p className="px-1 text-ink-400">Nothing matches “{term}”.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-ink-800 rounded border border-ink-800">
              {rows.map((r) => (
                <li key={r.arn}>
                  <button
                    onClick={() => onPick(r.arn)}
                    title={r.arn}
                    className="flex w-full items-baseline justify-between gap-2 px-2 py-1 text-left hover:bg-ink-850"
                  >
                    <span className="truncate text-ink-100">{r.name}</span>
                    <span className="shrink-0 text-[10px] text-ink-400">
                      {r.kind} · {r.region ?? "global"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {rows.length === 25 && (
            <p className="mt-1 px-1 text-[10px] text-ink-400">
              The first 25 matches: type more to narrow them.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
