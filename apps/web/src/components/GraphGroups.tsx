/**
 * A large account, as the groups it is made of: each VPC, then each kind of
 * resource that lives outside one.
 *
 * Drawing fifty thousand nodes answers nothing and stalls the tab, so a large
 * account opens here: groups with their findings counted, most exposed first,
 * and one opened at a time into the graph.
 */

import type { GraphGroup } from "../api.js";
import { KIND_STYLES } from "../kinds.js";

export function GraphGroups({
  groups,
  total,
  onOpen,
  cited,
  onShowCited,
}: {
  groups: GraphGroup[];
  total: number;
  onOpen: (id: string) => void;
  /** Resources an answer or a finding points at, which can be shown in context. */
  cited: number;
  onShowCited: () => void;
}) {
  return (
    <div className="h-full overflow-y-auto p-4">
      {cited > 0 && (
        <button
          onClick={onShowCited}
          className="mb-3 rounded border border-accent/50 bg-accent/10 px-2 py-1 text-[11px] text-accent"
        >
          Show the {cited} highlighted resource{cited === 1 ? "" : "s"} and their neighbours
        </button>
      )}
      <p className="mb-3 text-[12px] text-ink-400">
        {total.toLocaleString()} resources: too many to draw at once. Open a group, or pick a
        finding on the left or an answer's citation to see it in context.
      </p>
      <div
        className="grid gap-2"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}
      >
        {groups.map((g) => {
          const top = Object.entries(g.kinds)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 3)
            .map(([kind, n]) => `${n} ${KIND_STYLES[kind]?.label ?? kind}`);
          return (
            <button
              key={g.id}
              onClick={() => onOpen(g.id)}
              className="flex flex-col gap-1 rounded border border-ink-700 bg-ink-850 p-2.5 text-left transition hover:border-ink-600"
            >
              <span className="flex items-center gap-1.5">
                <span className="truncate text-[12px] text-ink-100">
                  {g.id.startsWith("vpc:") ? g.name : (KIND_STYLES[g.name]?.label ?? g.name)}
                </span>
                {g.region && <span className="text-[10px] text-ink-400">{g.region}</span>}
              </span>
              <span className="text-[11px] text-ink-300">{g.count.toLocaleString()} resources</span>
              <span className="truncate text-[10px] text-ink-400">{top.join(" · ")}</span>
              {(g.publicCount > 0 || g.adminCount > 0) && (
                <span className="flex gap-2 text-[10px]">
                  {g.publicCount > 0 && (
                    <span className="text-danger">{g.publicCount} exposed</span>
                  )}
                  {g.adminCount > 0 && <span className="text-warn">{g.adminCount} admin</span>}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
