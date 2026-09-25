/**
 * The findings sidebar.
 *
 * Standing answers to the questions a DevOps engineer opens this tool to ask,
 * available without typing anything. Clicking any row highlights it in the
 * graph, which is the same mechanism the agent's citations use.
 */

import { useState } from "react";
import type { Findings as FindingsData, GraphNode, Summary } from "../api.js";
import { ChangesPanel } from "./ChangesPanel.js";

export interface FindingsProps {
  summary: Summary | undefined;
  findings: FindingsData | undefined;
  loading: boolean;
  onHighlight: (arns: string[]) => void;
}

type Tab = "overview" | "exposed" | "admin" | "idle" | "changes" | "unprotected";

export function Findings({ summary, findings, loading, onHighlight }: FindingsProps) {
  const [tab, setTab] = useState<Tab>("overview");

  if (loading) {
    return (
      <div className="space-y-2 p-3">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-9 animate-pulse rounded bg-ink-850" />
        ))}
      </div>
    );
  }

  if (!summary || !findings) {
    return (
      <div className="p-3 text-[12px] text-ink-400">
        Nothing to show yet. Run a scan to populate the inventory.
      </div>
    );
  }

  const tabs: Array<{ id: Tab; label: string; count?: number; tone?: string }> = [
    { id: "overview", label: "Overview" },
    { id: "exposed", label: "Exposed", count: summary.publicCount, tone: "text-danger" },
    { id: "admin", label: "Admin", count: summary.adminCount, tone: "text-warn" },
    { id: "idle", label: "Idle", count: summary.idleCount },
    { id: "unprotected", label: "Unguarded", count: summary.unprotectedCount, tone: "text-warn" },
    { id: "changes", label: "Changes" },
  ];

  return (
    <div className="flex h-full flex-col">
      <div className="flex border-b border-ink-800">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex-1 border-b-2 px-2 py-1.5 text-[11px] transition ${
              tab === t.id
                ? "border-accent text-ink-100"
                : "border-transparent text-ink-400 hover:text-ink-300"
            }`}
          >
            {t.label}
            {t.count !== undefined && (
              <span className={`ml-1 ${t.tone ?? "text-ink-400"}`}>{t.count}</span>
            )}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-2.5">
        {tab === "overview" && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-1.5">
              <Stat label="Exposed" value={summary.publicCount} tone="text-danger" />
              <Stat label="Admin principals" value={summary.adminCount} tone="text-warn" />
              <Stat label="Idle" value={summary.idleCount} />
              <Stat label="Unguarded" value={summary.unprotectedCount} tone="text-warn" />
              <Stat
                label="Idle cost"
                value={`$${Math.round(summary.idleCost)}/mo`}
                tone="text-ink-100"
              />
            </div>
            <Section title="By type">
              {summary.byKind.slice(0, 12).map((k) => (
                <Row key={k.kind} left={k.kind} right={String(k.count)} />
              ))}
            </Section>
            <Section title="By region">
              {summary.byRegion.map((r) => (
                <Row key={r.region} left={r.region} right={String(r.count)} />
              ))}
            </Section>
          </div>
        )}

        {tab === "exposed" && (
          <FindingList
            items={findings.publicResources}
            empty="Nothing in this account is reachable from the internet."
            onHighlight={onHighlight}
          />
        )}

        {tab === "admin" && (
          <FindingList
            items={findings.adminPrincipals}
            empty="No role or user grants unrestricted access."
            onHighlight={onHighlight}
            extra={(item) => {
              const used = (item as { usedBy?: GraphNode[] }).usedBy ?? [];
              if (used.length > 0) return `Used by ${used.map((u) => u.name).join(", ")}`;
              /**
               * "Used by nothing" means different things for the two kinds, and
               * saying "candidate for removal" about an admin IAM user would be
               * wrong: a user has no instance profile or Lambda to be used by,
               * so an empty list carries no information about whether it is in
               * use. It has long-lived credentials instead, which is the risk.
               */
              return item.kind === "IamUser"
                ? "IAM user — standing admin via long-lived credentials"
                : "Used by nothing — candidate for removal";
            }}
          />
        )}

        {tab === "unprotected" && (
          <div className="space-y-2">
            {/*
              The distinction this tab exists for. Switching Block Public Access
              off grants nobody anything - it removes the guardrail that would
              neutralise a permissive policy. Buckets here are NOT public, and
              saying so plainly is the point: a real user expected the opposite.
            */}
            <p className="rounded border border-ink-800 bg-ink-850 px-2 py-1.5 text-[11px] leading-relaxed text-ink-400">
              <span className="text-ink-300">Not public — missing a guardrail.</span> These buckets
              have Block Public Access off or incomplete. Nothing grants anonymous access today, so
              a request still gets 403. What is missing is the setting that would neutralise a
              permissive policy if one were ever added.
            </p>
            <FindingList
              items={findings.unprotected}
              empty="Every bucket has Block Public Access fully enabled."
              onHighlight={onHighlight}
              extra={(item) =>
                (item as { isPublic?: boolean }).isPublic
                  ? "Also publicly reachable right now — see the Exposed tab"
                  : undefined
              }
            />
          </div>
        )}

        {tab === "changes" && <ChangesPanel onHighlight={onHighlight} />}

        {tab === "idle" && (
          <FindingList
            items={findings.idle}
            empty="Nothing obviously idle."
            onHighlight={onHighlight}
            extra={(item) =>
              item.estimatedMonthlyCostUsd ? `~$${item.estimatedMonthlyCostUsd}/month` : undefined
            }
          />
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="rounded border border-ink-800 bg-ink-850 px-2 py-1.5">
      <div className={`text-[16px] font-semibold ${tone ?? "text-ink-100"}`}>{value}</div>
      <div className="text-[10px] text-ink-400">{label}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-400">
        {title}
      </h3>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function Row({ left, right }: { left: string; right: string }) {
  return (
    <div className="flex items-center justify-between text-[11px]">
      <span className="text-ink-300">{left}</span>
      <span className="font-mono text-ink-400">{right}</span>
    </div>
  );
}

function FindingList({
  items,
  empty,
  onHighlight,
  extra,
}: {
  items: Array<GraphNode & { reason?: string | null }>;
  empty: string;
  onHighlight: (arns: string[]) => void;
  extra?: (item: GraphNode & { reason?: string | null }) => string | undefined;
}) {
  if (items.length === 0) {
    return <p className="py-3 text-center text-[12px] text-good">{empty}</p>;
  }
  return (
    <div className="space-y-1.5">
      {items.map((item) => (
        <button
          key={item.arn}
          onClick={() => onHighlight([item.arn])}
          className="block w-full rounded border border-ink-800 bg-ink-850 px-2 py-1.5 text-left transition hover:border-ink-600"
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-[12px] font-medium text-ink-100">{item.name}</span>
            <span className="shrink-0 text-[10px] text-ink-400">{item.region ?? "global"}</span>
          </div>
          {extra?.(item) && <div className="text-[10px] text-ink-300">{extra(item)}</div>}
          {item.reason && (
            <div className="mt-0.5 text-[10px] leading-snug text-ink-400">{item.reason}</div>
          )}
        </button>
      ))}
    </div>
  );
}
