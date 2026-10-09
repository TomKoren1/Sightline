/**
 * What changed between the last two scans.
 *
 * This was built server-side and answerable by the agent long before it was
 * visible here, which was the wrong way round: "what changed since yesterday,
 * and does any of it matter?" is the question that makes an inventory tool
 * something you open daily rather than once.
 *
 * The *matters* half is why modified resources lead with their changed security
 * verdicts rather than a raw field list. An instance gaining a public IP and an
 * instance gaining a tag are both "modified", and only one of them is worth
 * being woken up for.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  hasSignificantChange,
  SIGNIFICANT_CHANGE_FIELDS,
  sortFieldsBySignificance,
  type ResourceDiff,
} from "@sightline/shared";

import { api } from "../api.js";
import { styleFor } from "../kinds.js";

export function ChangesPanel({ onHighlight }: { onHighlight: (arns: string[]) => void }) {
  const [showAll, setShowAll] = useState(false);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["diff"],
    queryFn: api.diff,
  });

  if (isLoading) {
    return (
      <div className="space-y-2 p-1">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-10 animate-pulse rounded bg-ink-850" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-2 py-3 text-center">
        <p className="text-[11px] text-danger">{(error as Error).message}</p>
        <button
          onClick={() => void refetch()}
          className="rounded border border-ink-700 px-2 py-0.5 text-[11px] text-ink-300 hover:border-ink-600"
        >
          Retry
        </button>
      </div>
    );
  }

  // One scan is a normal state, not an error: there is simply nothing to
  // compare against yet.
  if (!data?.diff) {
    return (
      <p className="py-4 text-center text-[12px] leading-relaxed text-ink-400">
        {data?.reason ?? "Nothing to compare yet."}
        <br />
        <span className="text-[11px]">Run a second scan to see what changed.</span>
      </p>
    );
  }

  const { diff } = data;
  const changed = diff.added.length + diff.removed.length + diff.modified.length;

  const notable = diff.modified.filter(hasSignificantChange);
  const routine = diff.modified.filter((d) => !hasSignificantChange(d));

  if (changed === 0) {
    return (
      <div className="py-4 text-center">
        <p className="text-[12px] text-good">Nothing changed between the last two scans.</p>
        <p className="mt-1 text-[10px] text-ink-400">
          {new Date(diff.fromScanAt).toLocaleString()} → {new Date(diff.toScanAt).toLocaleString()}
        </p>
      </div>
    );
  }

  const allArns = [
    ...diff.added.map((d) => d.arn),
    ...diff.modified.map((d) => d.arn),
    // Removed resources are deliberately excluded: they are no longer in the
    // graph, so highlighting them would select nothing.
  ];

  return (
    <div className="space-y-3">
      <div className="rounded border border-ink-800 bg-ink-850 px-2 py-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[11px] text-ink-300">
            <span className="text-good">+{diff.added.length}</span>{" "}
            <span className="text-danger">−{diff.removed.length}</span>{" "}
            <span className="text-warn">~{diff.modified.length}</span>
          </span>
          {allArns.length > 0 && (
            <button
              onClick={() => onHighlight(allArns)}
              className="text-[10px] text-accent hover:underline"
            >
              show in graph
            </button>
          )}
        </div>
        <p className="mt-0.5 text-[10px] text-ink-400">
          {new Date(diff.fromScanAt).toLocaleString()} → {new Date(diff.toScanAt).toLocaleString()}
        </p>
      </div>

      {notable.length > 0 && (
        <Group title="Worth looking at" tone="text-warn">
          {notable.map((d) => (
            <DiffRow key={d.arn} diff={d} onHighlight={onHighlight} highlightFields />
          ))}
        </Group>
      )}

      {diff.added.length > 0 && (
        <Group title="Added" tone="text-good">
          {diff.added.map((d) => (
            <DiffRow key={d.arn} diff={d} onHighlight={onHighlight} />
          ))}
        </Group>
      )}

      {diff.removed.length > 0 && (
        <Group title="Removed" tone="text-danger">
          {diff.removed.map((d) => (
            <DiffRow key={d.arn} diff={d} />
          ))}
        </Group>
      )}

      {routine.length > 0 && (
        <Group title={`Other changes (${routine.length})`} tone="text-ink-400">
          {showAll ? (
            routine.map((d) => <DiffRow key={d.arn} diff={d} onHighlight={onHighlight} />)
          ) : (
            <button
              onClick={() => setShowAll(true)}
              className="text-[11px] text-accent hover:underline"
            >
              show {routine.length} routine change{routine.length === 1 ? "" : "s"}
            </button>
          )}
        </Group>
      )}
    </div>
  );
}

function Group({
  title,
  tone,
  children,
}: {
  title: string;
  tone: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h3 className={`mb-1 text-[10px] font-semibold uppercase tracking-wider ${tone}`}>{title}</h3>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function DiffRow({
  diff,
  onHighlight,
  highlightFields,
}: {
  diff: ResourceDiff;
  onHighlight?: (arns: string[]) => void;
  highlightFields?: boolean;
}) {
  const style = styleFor(diff.kind);
  const fields = diff.changedFields ?? [];
  const shown = highlightFields ? sortFieldsBySignificance(fields) : fields;

  const body = (
    <>
      <div className="flex items-baseline gap-1.5">
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: style.color }}
          aria-hidden
        />
        <span className="truncate text-[11px] font-medium text-ink-100">{diff.name}</span>
        <span className="shrink-0 text-[10px] text-ink-400">{style.label}</span>
      </div>
      {shown.slice(0, 4).map((f) => (
        <div
          key={f.field}
          className={`pl-3 font-mono text-[10px] ${
            SIGNIFICANT_CHANGE_FIELDS.has(f.field) ? "text-warn" : "text-ink-400"
          }`}
        >
          {f.field}: {format(f.before)} → {format(f.after)}
        </div>
      ))}
      {shown.length > 4 && (
        <div className="pl-3 text-[10px] text-ink-400">+{shown.length - 4} more fields</div>
      )}
    </>
  );

  if (!onHighlight) {
    return <div className="rounded border border-ink-800 bg-ink-850 px-2 py-1">{body}</div>;
  }

  return (
    <button
      onClick={() => onHighlight([diff.arn])}
      className="block w-full rounded border border-ink-800 bg-ink-850 px-2 py-1 text-left transition hover:border-ink-600"
    >
      {body}
    </button>
  );
}

/** Keep values short: a diff row is a summary, and the detail panel has the rest. */
function format(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "object") {
    const json = JSON.stringify(value);
    return json.length > 40 ? `${json.slice(0, 40)}…` : json;
  }
  const text = String(value);
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}
