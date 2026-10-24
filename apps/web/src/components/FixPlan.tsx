/**
 * The fix plan: every computed fix for the account's open findings, chosen by
 * the person who will run them, downloaded as a script or as Terraform.
 *
 * High-risk fixes start unticked. Each one says what it could break - a public
 * bucket may be public on purpose - and choosing it should be a decision, not
 * a default.
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fixPlanScript, fixPlanTerraform } from "@sightline/shared";

import { api } from "../api.js";
import type { FixPlanItem } from "@sightline/shared/api";

const RISKS = ["low", "medium", "high"] as const;
type Risk = (typeof RISKS)[number];
const RISK_STYLE: Record<Risk, string> = {
  low: "text-good",
  medium: "text-warn",
  high: "text-danger",
};

const keyOf = (i: FixPlanItem) => `${i.arn}|${i.remediation.id}`;

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function FixPlan() {
  const plan = useQuery({ queryKey: ["fixPlan"], queryFn: api.fixPlan });
  const items = useMemo(() => plan.data?.items ?? [], [plan.data]);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);

  // Low and medium start chosen; high is a decision, so it starts unticked.
  useEffect(() => {
    setChosen(new Set(items.filter((i) => i.remediation.risk !== "high").map(keyOf)));
  }, [items]);

  if (plan.isLoading) return <div className="h-40 animate-pulse rounded bg-ink-850" />;
  if (plan.error) return <p className="text-[12px] text-danger">{plan.error.message}</p>;
  const data = plan.data!;
  if (items.length === 0) {
    return (
      <p className="text-[12px] text-ink-300">
        Nothing to fix: no open finding has a computed fix
        {data.withoutFix.length > 0 ? `, and ${data.withoutFix.length} need a person` : ""}.
      </p>
    );
  }

  const selected = items.filter((i) => chosen.has(keyOf(i)));
  const header = { accountId: data.accountId, scanId: data.scanId, at: new Date() };
  const terraform = fixPlanTerraform(header, selected);
  const stamp = new Date().toISOString().slice(0, 10);
  const toggle = (keys: string[], on: boolean) =>
    setChosen((prev) => {
      const next = new Set(prev);
      for (const k of keys) {
        if (on) next.add(k);
        else next.delete(k);
      }
      return next;
    });

  return (
    <div className="flex max-h-[70vh] flex-col gap-3 text-[12px]">
      <p className="text-ink-300">
        {items.length} fixes for the open findings. Choose what to include and download it to read
        and run yourself: Sightline has read-only access and applies none of this. The script asks
        before every step.
      </p>

      <div className="min-h-0 flex-1 space-y-3 overflow-auto pr-1">
        {RISKS.map((risk) => {
          const group = items.filter((i) => i.remediation.risk === risk);
          if (group.length === 0) return null;
          const keys = group.map(keyOf);
          const all = keys.every((k) => chosen.has(k));
          return (
            <section key={risk}>
              <label className="mb-1 flex items-center gap-2 font-semibold">
                <input
                  type="checkbox"
                  checked={all}
                  onChange={(e) => toggle(keys, e.target.checked)}
                />
                <span className={RISK_STYLE[risk]}>
                  {risk[0]!.toUpperCase() + risk.slice(1)} risk
                </span>
                <span className="font-normal text-ink-400">({group.length})</span>
              </label>
              <ul className="divide-y divide-ink-800 rounded border border-ink-800">
                {group.map((item) => {
                  const k = keyOf(item);
                  return (
                    <li key={k} className="px-2 py-1.5">
                      <div className="flex items-start gap-2">
                        <input
                          type="checkbox"
                          aria-label={`${item.remediation.title} - ${item.name}`}
                          checked={chosen.has(k)}
                          onChange={(e) => toggle([k], e.target.checked)}
                          className="mt-0.5"
                        />
                        <button
                          onClick={() => setOpen(open === k ? null : k)}
                          className="min-w-0 flex-1 text-left"
                        >
                          <p className="text-ink-100">{item.remediation.title}</p>
                          <p className="truncate text-[11px] text-ink-400">
                            {item.kind} {item.name}
                            {item.region ? ` · ${item.region}` : ""}
                          </p>
                        </button>
                      </div>
                      {open === k && (
                        <div className="ml-6 mt-1 space-y-1 text-[11px]">
                          <p className="text-ink-300">{item.remediation.summary}</p>
                          <p className="text-warn">Caution: {item.remediation.caution}</p>
                          <pre className="overflow-x-auto rounded bg-ink-950 p-1.5 font-mono text-[10px] text-ink-300">
                            {item.remediation.cli.join("\n")}
                          </pre>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}

        {data.withoutFix.length > 0 && (
          <section>
            <h4 className="mb-1 font-semibold text-ink-100">
              Need a person ({data.withoutFix.length})
            </h4>
            <p className="mb-1 text-[11px] text-ink-400">
              Flagged, but with no command safe to compute from what the scan saw. Open each from
              the findings list to see why.
            </p>
            <p className="text-[11px] text-ink-300">
              {data.withoutFix
                .slice(0, 20)
                .map((r) => r.name)
                .join(", ")}
              {data.withoutFix.length > 20 ? ` and ${data.withoutFix.length - 20} more` : ""}
            </p>
          </section>
        )}
        {data.truncated && (
          <p className="text-[11px] text-warn">
            This account has more flagged resources than one plan holds; fix these and rescan for
            the rest.
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-ink-800 pt-3">
        <button
          disabled={selected.length === 0}
          onClick={() =>
            download(
              `sightline-fix-plan-${stamp}.sh`,
              fixPlanScript(header, selected),
              "text/x-shellscript",
            )
          }
          className="rounded bg-accent px-3 py-1.5 text-[12px] font-medium text-ink-950 transition hover:brightness-110 disabled:opacity-40"
        >
          Download script ({selected.length} {selected.length === 1 ? "step" : "steps"})
        </button>
        <button
          disabled={terraform.included === 0}
          onClick={() => download(`sightline-fix-plan-${stamp}.tf`, terraform.text, "text/plain")}
          className="rounded border border-ink-700 bg-ink-800 px-3 py-1.5 text-[12px] text-ink-100 transition hover:border-ink-600 disabled:opacity-40"
        >
          Download Terraform ({terraform.included} of {selected.length})
        </button>
        <span className="text-[11px] text-ink-400">
          Terraform holds only the fixes it can declare; the rest change resources it does not
          manage, so they are script-only.
        </span>
      </div>
    </div>
  );
}
