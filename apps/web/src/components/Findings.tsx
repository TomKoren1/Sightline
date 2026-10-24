/**
 * The findings sidebar.
 *
 * Standing answers to the questions a DevOps engineer opens this tool to ask,
 * available without typing anything. Clicking any row highlights it in the
 * graph, which is the same mechanism the agent's citations use.
 *
 * A finding can be accepted with a reason - the website bucket that is meant
 * to be public - and then leaves its list for a collapsed "accepted" section
 * under it, where it can be reopened. The decision survives rescans; fixing the
 * resource resolves it, and a finding that comes back asks again.
 */

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type FindingCategory,
  type FindingState,
  type Findings as FindingsData,
  type GraphNode,
  type Summary,
} from "../api.js";
import { controlsFor } from "@sightline/shared";

import { ChangesPanel } from "./ChangesPanel.js";

export interface FindingsProps {
  summary: Summary | undefined;
  findings: FindingsData | undefined;
  loading: boolean;
  onHighlight: (arns: string[]) => void;
}

type Tab = "overview" | "exposed" | "admin" | "idle" | "unused" | "changes" | "unprotected";

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

  // The summary counts every verdict; what still needs somebody is that less
  // what somebody has already accepted.
  const acceptedIn = (category: FindingCategory) =>
    findings.accepted.filter((f) => f.category === category);
  const open = (count: number, category: FindingCategory) =>
    Math.max(0, count - acceptedIn(category).length);

  const tabs: { id: Tab; label: string; count?: number; tone?: string }[] = [
    { id: "overview", label: "Overview" },
    {
      id: "exposed",
      label: "Exposed",
      count: open(summary.publicCount, "exposed"),
      tone: "text-danger",
    },
    { id: "admin", label: "Admin", count: open(summary.adminCount, "admin"), tone: "text-warn" },
    { id: "idle", label: "Idle", count: open(summary.idleCount, "idle") },
    { id: "unused", label: "Unused", count: open(summary.unusedCount ?? 0, "unused") },
    {
      id: "unprotected",
      label: "Unguarded",
      count: open(summary.unprotectedCount, "unguarded"),
      tone: "text-warn",
    },
    { id: "changes", label: "Changes" },
  ];

  return (
    <div className="flex h-full flex-col">
      {/* Wraps rather than overflowing. Six labels do not fit across a 288px
          sidebar, and flex items default to `min-width: auto`, so they refused
          to shrink and spilled across the graph pane instead - where the
          floating Filter button then covered two of them. Rows of three is the
          only arrangement that keeps every label readable and inside the
          column; the seventh tab takes a row of its own. Found by screenshotting the running UI. */}
      <div className="flex flex-wrap border-b border-ink-800">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`min-w-0 basis-1/3 grow border-b-2 px-2 py-1.5 text-[11px] transition ${
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
              <Stat
                label="Exposed"
                value={open(summary.publicCount, "exposed")}
                tone="text-danger"
              />
              <Stat
                label="Admin principals"
                value={open(summary.adminCount, "admin")}
                tone="text-warn"
              />
              <Stat label="Idle" value={open(summary.idleCount, "idle")} />
              <Stat label="Unused access" value={open(summary.unusedCount ?? 0, "unused")} />
              <Stat
                label="Unguarded"
                value={open(summary.unprotectedCount, "unguarded")}
                tone="text-warn"
              />
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
            accepted={acceptedIn("exposed")}
            category="exposed"
            empty="Nothing in this account is reachable from the internet."
            onHighlight={onHighlight}
          />
        )}

        {tab === "admin" && (
          <FindingList
            items={findings.adminPrincipals}
            accepted={acceptedIn("admin")}
            category="admin"
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
              accepted={acceptedIn("unguarded")}
              category="unguarded"
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

        {tab === "unused" && (
          <FindingList
            items={findings.unused ?? []}
            accepted={acceptedIn("unused")}
            category="unused"
            empty="Every role and user has been used in the last 90 days, or is newer than that."
            onHighlight={onHighlight}
            extra={(item) =>
              item.isAdmin ? "Administrator — the most valuable thing to remove" : undefined
            }
          />
        )}

        {tab === "idle" && (
          <FindingList
            items={findings.idle}
            accepted={acceptedIn("idle")}
            category="idle"
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

type Item = GraphNode & { reason?: string | null; finding?: FindingState | null };

function FindingList({
  items,
  accepted,
  category,
  empty,
  onHighlight,
  extra,
}: {
  items: Item[];
  category: FindingCategory;
  accepted: Item[];
  empty: string;
  onHighlight: (arns: string[]) => void;
  extra?: (item: Item) => string | undefined;
}) {
  const [showAccepted, setShowAccepted] = useState(false);
  return (
    <div className="space-y-1.5">
      {items.length === 0 ? (
        <p className="py-3 text-center text-[12px] text-good">{empty}</p>
      ) : (
        items.map((item) => (
          <FindingRow
            key={item.arn}
            item={item}
            category={category}
            onHighlight={onHighlight}
            extra={extra}
          />
        ))
      )}
      {accepted.length > 0 && (
        <div className="pt-1">
          <button
            onClick={() => setShowAccepted((v) => !v)}
            aria-expanded={showAccepted}
            className="text-[10px] font-semibold uppercase tracking-wider text-ink-400 hover:text-ink-300"
          >
            {showAccepted ? "▾" : "▸"} Accepted ({accepted.length})
          </button>
          {showAccepted && (
            <div className="mt-1.5 space-y-1.5">
              {accepted.map((item) => (
                <FindingRow
                  key={item.arn}
                  item={item}
                  category={category}
                  onHighlight={onHighlight}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * One finding. The row itself highlights; accepting is a separate control
 * beside it rather than inside it, because a button inside a button is invalid
 * markup and swallows the inner click in some browsers.
 */
function FindingRow({
  item,
  category,
  onHighlight,
  extra,
}: {
  item: Item;
  category: FindingCategory;
  onHighlight: (arns: string[]) => void;
  extra?: (item: Item) => string | undefined;
}) {
  const queryClient = useQueryClient();
  const [accepting, setAccepting] = useState(false);
  const [reason, setReason] = useState("");
  const finding = item.finding ?? null;
  const isAccepted = finding?.status === "accepted";

  const change = useMutation({
    mutationFn: (body: { status: "accepted"; reason: string } | { status: "open" }) =>
      api.setFindingStatus(finding!.id, body),
    onSuccess: async () => {
      setAccepting(false);
      setReason("");
      await queryClient.invalidateQueries({ queryKey: ["findings"] });
    },
  });

  const detail = extra?.(item);
  // Plain text, not links: the row is itself a button. The title names each.
  const controls = controlsFor(category, item.kind);
  return (
    <div
      className={`rounded border border-ink-800 bg-ink-850 transition hover:border-ink-600 ${
        isAccepted ? "opacity-70" : ""
      }`}
    >
      <button
        onClick={() => onHighlight([item.arn])}
        className="block w-full px-2 pb-1 pt-1.5 text-left"
      >
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[12px] font-medium text-ink-100">{item.name}</span>
          <span className="shrink-0 text-[10px] text-ink-400">{item.region ?? "global"}</span>
        </div>
        {detail && <div className="text-[10px] text-ink-300">{detail}</div>}
        {item.reason && (
          <div className="mt-0.5 text-[10px] leading-snug text-ink-400">{item.reason}</div>
        )}
        {controls.length > 0 && (
          <div
            className="mt-0.5 font-mono text-[10px] text-ink-400"
            title={controls.map((c) => `${c.framework} ${c.id}: ${c.title}`).join("\n")}
          >
            {controls.map((c) => `FSBP ${c.id}`).join(" · ")}
          </div>
        )}
        {isAccepted && finding.statusReason && (
          <div className="mt-0.5 text-[10px] leading-snug text-ink-300">
            Accepted: {finding.statusReason}
          </div>
        )}
      </button>

      {/* A finding no scan has recorded yet - the account was last scanned
          before tracking existed - has nothing to accept until the next scan. */}
      {finding && (
        <div className="px-2 pb-1.5">
          {accepting ? (
            <form
              className="space-y-1"
              onSubmit={(e) => {
                e.preventDefault();
                change.mutate({ status: "accepted", reason: reason.trim() });
              }}
            >
              <input
                autoFocus
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={500}
                placeholder="Why is this acceptable?"
                aria-label={`Reason for accepting ${item.name}`}
                className="w-full rounded border border-ink-700 bg-ink-900 px-1.5 py-1 text-[11px] text-ink-100 placeholder:text-ink-400 focus:border-accent focus:outline-none"
              />
              <div className="flex gap-2 text-[10px]">
                <button
                  type="submit"
                  disabled={reason.trim().length < 3 || change.isPending}
                  className="text-accent disabled:text-ink-400"
                >
                  Accept risk
                </button>
                <button
                  type="button"
                  onClick={() => setAccepting(false)}
                  className="text-ink-400 hover:text-ink-300"
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <div className="flex items-center justify-between text-[10px]">
              <span className="text-ink-400">
                Since {new Date(finding.firstSeenAt).toLocaleDateString()}
              </span>
              {isAccepted ? (
                <button
                  onClick={() => change.mutate({ status: "open" })}
                  disabled={change.isPending}
                  className="text-ink-400 hover:text-ink-100"
                >
                  Reopen
                </button>
              ) : (
                <button
                  onClick={() => setAccepting(true)}
                  aria-label={`Accept the risk of ${item.name}`}
                  className="text-ink-400 hover:text-ink-100"
                >
                  Accept…
                </button>
              )}
            </div>
          )}
          {change.isError && (
            <div className="mt-0.5 text-[10px] text-danger">{change.error.message}</div>
          )}
        </div>
      )}
    </div>
  );
}
