/**
 * Application shell.
 *
 * Layout: state banner across the top, findings on the left, graph in the
 * middle, chat on the right. The graph is the shared surface - both the
 * sidebar and the agent highlight nodes on it, so a finding and an answer feel
 * like the same thing rather than two features.
 */

import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ReactFlowProvider } from "@xyflow/react";
import type { ScanEvent, ScanUnit } from "@daveio/shared";

import { api, startScan } from "./api.js";
import { AccountMenu, SignInGate } from "./components/SignIn.js";
import { DEFAULT_VISIBLE_KINDS, KIND_STYLES, styleFor } from "./kinds.js";
import { Chat } from "./components/Chat.js";
import { ConnectionGuide } from "./components/ConnectionGuide.js";
import { Modal } from "./components/Modal.js";
import { TrustPanel } from "./components/TrustPanel.js";
import { Findings } from "./components/Findings.js";
import { GraphView } from "./components/GraphView.js";
import { ResourceDetail } from "./components/ResourceDetail.js";
import { ScanBanner } from "./components/ScanBanner.js";

export function App() {
  const queryClient = useQueryClient();

  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<{ completed: number; total: number } | null>(null);
  const [liveUnits, setLiveUnits] = useState<ScanUnit[]>([]);
  const [scanError, setScanError] = useState<string | null>(null);

  const [citedArns, setCitedArns] = useState<string[]>([]);
  const [selectedArn, setSelectedArn] = useState<string | null>(null);
  const [visibleKinds, setVisibleKinds] = useState<string[]>(DEFAULT_VISIBLE_KINDS);
  const [showFilters, setShowFilters] = useState(false);
  const [modal, setModal] = useState<"trust" | "connection" | null>(null);
  const [modeNote, setModeNote] = useState<string | null>(null);

  /**
   * Who is signed in, asked before anything else.
   *
   * Self-hosted answers "single tenant, no sign-in needed" and everything
   * below proceeds exactly as it always has. Hosted answers with a user or
   * with null, and null means the gate renders instead of the app - not
   * instead of each panel, because a gate per panel is a gate somebody
   * forgets to add.
   */
  const me = useQuery({ queryKey: ["me"], queryFn: api.me, retry: false });
  const signedIn = me.data ? me.data.mode === "self-hosted" || me.data.user !== null : false;

  const latest = useQuery({
    queryKey: ["latestScan"],
    queryFn: api.latestScan,
    enabled: signedIn,
  });
  const hasScan = Boolean(latest.data?.scan);

  // The graph and findings are meaningless before a scan, so they are not
  // fetched until there is one - which also keeps the empty state clean.
  const graph = useQuery({
    queryKey: ["graph"],
    queryFn: () => api.graph(),
    enabled: hasScan && signedIn,
  });
  const summary = useQuery({
    queryKey: ["summary"],
    queryFn: api.summary,
    enabled: hasScan && signedIn,
  });
  const findings = useQuery({
    queryKey: ["findings"],
    queryFn: api.findings,
    enabled: hasScan && signedIn,
  });

  const runScan = useCallback(async () => {
    setScanning(true);
    setScanError(null);
    setModeNote(null);
    setLiveUnits([]);
    setProgress(null);
    setCitedArns([]);

    try {
      await startScan((event: ScanEvent) => {
        switch (event.type) {
          case "scan.started":
            // The full plan arrives up front, so the UI shows every service it
            // intends to scan rather than growing a list as work completes.
            setLiveUnits(event.units);
            setProgress({ completed: 0, total: event.units.length });
            break;
          case "unit.finished":
            setLiveUnits((prev) =>
              prev.map((u) =>
                u.service === event.unit.service && u.region === event.unit.region ? event.unit : u,
              ),
            );
            break;
          case "scan.progress":
            setProgress({ completed: event.completed, total: event.total });
            break;
          case "scan.failed":
            setScanError(event.error);
            break;
          default:
            break;
        }
      });

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["latestScan"] }),
        queryClient.invalidateQueries({ queryKey: ["graph"] }),
        queryClient.invalidateQueries({ queryKey: ["summary"] }),
        queryClient.invalidateQueries({ queryKey: ["findings"] }),
      ]);
    } catch (err) {
      setScanError(err instanceof Error ? err.message : String(err));
    } finally {
      setScanning(false);
    }
  }, [queryClient]);

  const nodes = graph.data?.nodes ?? [];
  const edges = graph.data?.edges ?? [];
  const presentKinds = [...new Set(nodes.map((n) => n.kind))].sort();

  // Nothing is known yet: render nothing rather than flashing the sign-in
  // screen at somebody who is already signed in.
  if (me.isLoading) return <div className="h-screen bg-ink-950" />;
  if (me.data && !signedIn) return <SignInGate me={me.data} />;

  return (
    <div className="flex h-screen flex-col">
      <ScanBanner
        accountMenu={me.data ? <AccountMenu me={me.data} /> : null}
        scan={latest.data?.scan ?? null}
        scanning={scanning}
        progress={progress}
        liveUnits={liveUnits}
        error={scanError}
        onScan={() => void runScan()}
        onOpenTrust={() => setModal("trust")}
        onOpenConnection={() => setModal("connection")}
        modeNote={modeNote}
        onModeSwitched={(note) => {
          setModeNote(note);
          setCitedArns([]);
          setSelectedArn(null);
        }}
      />

      {modal === "trust" && (
        <Modal
          title="Can you trust this?"
          subtitle="What is checked, how, and when it last ran"
          onClose={() => setModal(null)}
        >
          <TrustPanel />
        </Modal>
      )}

      {modal === "connection" && (
        <Modal
          title="Connect an AWS account"
          subtitle="Read-only access to your account, in about five minutes"
          onClose={() => setModal(null)}
        >
          <ConnectionGuide />
        </Modal>
      )}

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-72 shrink-0 flex-col overflow-hidden border-r border-ink-800 bg-ink-900">
          <Findings
            summary={summary.data}
            findings={findings.data}
            loading={hasScan && (summary.isLoading || findings.isLoading)}
            onHighlight={setCitedArns}
          />
        </aside>

        <main className="relative min-w-0 flex-1">
          {!hasScan && !scanning ? (
            <EmptyState onScan={() => void runScan()} />
          ) : graph.isLoading ? (
            <div className="flex h-full items-center justify-center text-[12px] text-ink-400">
              Loading graph…
            </div>
          ) : graph.error ? (
            <div className="flex h-full flex-col items-center justify-center gap-2">
              <p className="text-[12px] text-danger">
                Could not load the graph: {(graph.error as Error).message}
              </p>
              <button
                onClick={() => void graph.refetch()}
                className="rounded border border-ink-700 px-2.5 py-1 text-[11px] text-ink-300 hover:border-ink-600"
              >
                Retry
              </button>
            </div>
          ) : nodes.length === 0 ? (
            <div className="flex h-full items-center justify-center text-[12px] text-ink-400">
              The scan completed but found no resources.
            </div>
          ) : (
            <ReactFlowProvider>
              <GraphView
                nodes={nodes}
                edges={edges}
                visibleKinds={visibleKinds}
                citedArns={citedArns}
                onSelect={setSelectedArn}
                selectedArn={selectedArn}
              />
            </ReactFlowProvider>
          )}

          {hasScan && nodes.length > 0 && (
            <div className="absolute left-2.5 top-2.5 z-10 flex items-center gap-1.5">
              <button
                onClick={() => setShowFilters((v) => !v)}
                className="rounded border border-ink-700 bg-ink-850/95 px-2 py-1 text-[11px] text-ink-300 backdrop-blur transition hover:border-ink-600"
              >
                Filter ({visibleKinds.length}/{presentKinds.length})
              </button>
              {citedArns.length > 0 && (
                <button
                  onClick={() => setCitedArns([])}
                  className="rounded border border-accent/50 bg-accent/10 px-2 py-1 text-[11px] text-accent backdrop-blur"
                >
                  {citedArns.length} highlighted · clear
                </button>
              )}
            </div>
          )}

          {showFilters && (
            <div className="absolute left-2.5 top-11 z-10 max-h-[60vh] w-56 overflow-y-auto rounded border border-ink-700 bg-ink-850/98 p-2 backdrop-blur">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-400">
                  Resource types
                </span>
                <button
                  onClick={() =>
                    setVisibleKinds(visibleKinds.length === presentKinds.length ? [] : presentKinds)
                  }
                  className="text-[10px] text-accent"
                >
                  {visibleKinds.length === presentKinds.length ? "None" : "All"}
                </button>
              </div>
              {presentKinds.map((kind) => {
                const count = nodes.filter((n) => n.kind === kind).length;
                return (
                  <label
                    key={kind}
                    className="flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 hover:bg-ink-800"
                  >
                    <input
                      type="checkbox"
                      checked={visibleKinds.includes(kind)}
                      onChange={(e) =>
                        setVisibleKinds((prev) =>
                          e.target.checked ? [...prev, kind] : prev.filter((k) => k !== kind),
                        )
                      }
                      className="accent-accent"
                    />
                    <span
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ background: styleFor(kind).color }}
                    />
                    <span className="flex-1 truncate text-[11px] text-ink-300">
                      {KIND_STYLES[kind]?.label ?? kind}
                    </span>
                    <span className="text-[10px] text-ink-400">{count}</span>
                  </label>
                );
              })}
            </div>
          )}
        </main>

        {selectedArn && (
          <aside className="w-80 shrink-0">
            <ResourceDetail
              arn={selectedArn}
              onClose={() => setSelectedArn(null)}
              onSelect={setSelectedArn}
            />
          </aside>
        )}

        <aside className="w-96 shrink-0 border-l border-ink-800">
          <Chat ready={hasScan} onCitations={setCitedArns} />
        </aside>
      </div>
    </div>
  );
}

function EmptyState({ onScan }: { onScan: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <h2 className="text-[15px] font-semibold text-ink-100">No inventory yet</h2>
      <p className="max-w-sm text-[12px] leading-relaxed text-ink-400">
        Dave connects to the customer account with a read-only role, discovers what is there, and
        builds a graph of how it fits together. Nothing is ever modified.
      </p>
      <button
        onClick={onScan}
        className="rounded bg-accent px-3 py-1.5 text-[12px] font-medium text-ink-950 transition hover:brightness-110"
      >
        Run the first scan
      </button>
    </div>
  );
}
