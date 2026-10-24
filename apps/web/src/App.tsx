/**
 * Application shell.
 *
 * Layout: state banner across the top, findings on the left, graph in the
 * middle, chat on the right. The graph is the shared surface - both the
 * sidebar and the agent highlight nodes on it, so a finding and an answer feel
 * like the same thing rather than two features.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ReactFlowProvider } from "@xyflow/react";
import type { ScanEvent, ScanUnit } from "@sightline/shared";

import { api, can, selectConnection, startScan, watchScan } from "./api.js";
import { captureJoinToken, clearJoin, pendingJoin } from "./join.js";
import { Team } from "./components/Team.js";
import type { ConnectionSummary, GraphData } from "./api.js";
import { GraphGroups } from "./components/GraphGroups.js";
import { FOCUS, LARGE_ACCOUNT, mergeGraphs } from "./graphViews.js";
import { DEFAULT_VISIBLE_KINDS, KIND_STYLES, styleFor } from "./kinds.js";
import { Chat } from "./components/Chat.js";
import { ConnectAccount } from "./components/ConnectAccount.js";
import { ConnectionGuide } from "./components/ConnectionGuide.js";
import { DeleteAccount } from "./components/DeleteAccount.js";
import { DisconnectAccount } from "./components/DisconnectAccount.js";
import { Modal } from "./components/Modal.js";
import { TrustPanel } from "./components/TrustPanel.js";
import { Findings } from "./components/Findings.js";
import { GraphView } from "./components/GraphView.js";
import { LegalPage, legalPathFor } from "./components/LegalPage.js";
import { ResourceDetail } from "./components/ResourceDetail.js";
import { ScanBanner } from "./components/ScanBanner.js";
import { SignIn } from "./components/SignIn.js";
import { errorMessage } from "@sightline/shared";

export function App() {
  const queryClient = useQueryClient();

  const [scanning, setScanning] = useState(false);
  /** Accepted, but no worker has picked it up yet. */
  const [queued, setQueued] = useState(false);
  const [progress, setProgress] = useState<{ completed: number; total: number } | null>(null);
  const [liveUnits, setLiveUnits] = useState<ScanUnit[]>([]);
  const [scanError, setScanError] = useState<string | null>(null);

  const [citedArns, setCitedArns] = useState<string[]>([]);
  const [selectedArn, setSelectedArn] = useState<string | null>(null);
  const [visibleKinds, setVisibleKinds] = useState<string[]>(DEFAULT_VISIBLE_KINDS);
  const [showFilters, setShowFilters] = useState(false);
  const [modal, setModal] = useState<"trust" | "connection" | "delete" | "team" | null>(null);
  const [connectionId, setConnectionId] = useState<string | null>(null);
  /**
   * The account a disconnect has been asked for, pending confirmation.
   *
   * Held as the row rather than its id, because the dialog names the account
   * and asks for its label back - and the row is gone from `me` by the time
   * the dialog closes.
   */
  const [disconnecting, setDisconnecting] = useState<ConnectionSummary | null>(null);

  /**
   * Who is asking, and which accounts they have. One request before the first
   * frame, so there is no flash of an empty app for a signed-out visitor.
   */
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const connections = me.data?.connections ?? [];

  // An invite link: kept across the sign-in round trip, accepted once signed in.
  const [joinError, setJoinError] = useState<string | null>(null);
  const [invited] = useState(() => {
    captureJoinToken();
    return pendingJoin() !== null;
  });
  const signedInHosted = Boolean(me.data?.hosted && me.data.signedIn);
  useEffect(() => {
    const token = signedInHosted ? pendingJoin() : null;
    if (!token) return;
    clearJoin();
    const joining = api.joinTeam(token);
    joining
      .then(() => queryClient.invalidateQueries())
      .catch((err: unknown) => setJoinError(errorMessage(err)));
  }, [signedInHosted, queryClient]);

  /**
   * Every tenant-data query is keyed by the connection.
   *
   * Without this, switching accounts would show the previous account's cached
   * graph under the new account's name - which is the specific confusion the
   * banner exists to prevent, arriving by a different route.
   */
  const conn = connectionId ?? connections[0]?.id ?? null;

  const latest = useQuery({
    queryKey: ["latestScan", conn],
    queryFn: api.latestScan,
    enabled: Boolean(conn),
  });
  const hasScan = Boolean(latest.data?.scan);

  // The graph and findings are meaningless before a scan, so they are not
  // fetched until there is one - which also keeps the empty state clean.
  const summary = useQuery({ queryKey: ["summary", conn], queryFn: api.summary, enabled: hasScan });
  const totalResources = (summary.data?.byKind ?? []).reduce((sum, k) => sum + k.count, 0);
  /**
   * A large account opens on its groups rather than on everything, and is
   * drawn a group, or a neighbourhood, at a time. `group` is which: null is
   * the whole graph or the overview, FOCUS is only what has been expanded.
   */
  const large = totalResources > LARGE_ACCOUNT;
  const [group, setGroup] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<GraphData[]>([]);
  useEffect(() => {
    setGroup(null);
    setExpanded([]);
  }, [conn]);
  const graph = useQuery({
    queryKey: ["graph", conn, group],
    queryFn: () => api.graph(group ? { group, limit: 300 } : {}),
    enabled: hasScan && summary.isSuccess && (!large || (group !== null && group !== FOCUS)),
  });
  const groups = useQuery({
    queryKey: ["graph-groups", conn],
    queryFn: api.graphGroups,
    enabled: hasScan && large,
  });
  const shown = useMemo(() => mergeGraphs([graph.data, ...expanded]), [graph.data, expanded]);
  const expand = useCallback(
    async (arns: string[]) => {
      const found = await Promise.all(arns.slice(0, 8).map((arn) => api.graphNeighbours(arn)));
      if (large && group === null) setGroup(FOCUS);
      setExpanded((prev) => [...prev, ...found]);
    },
    [large, group],
  );
  const findings = useQuery({
    queryKey: ["findings", conn],
    queryFn: api.findings,
    enabled: hasScan,
  });

  const switchConnection = useCallback(
    (id: string) => {
      selectConnection(id);
      setConnectionId(id);
      setCitedArns([]);
      setSelectedArn(null);
      /**
       * No note about the graph being stale, because it is not.
       *
       * Each connection's graph is its own latest projected scan, looked up
       * per request, and every query here is keyed by the connection - so this
       * invalidation loads the account being switched to. The banner then says
       * what that account actually has, from its own data: a resource count
       * and the age of its scan, or "No scan yet".
       *
       * The note this replaces said the graph still showed the previous scan
       * and told the reader to run one. That was true of the process-wide
       * demo/real toggle it was written for, and false here - and it sent
       * people to rescan an account whose inventory was already loaded, which
       * a cooldown then refused.
       */
      void queryClient.invalidateQueries();
    },
    [queryClient],
  );

  /**
   * One handler, whether this page started the scan or joined one in progress.
   *
   * Both paths receive the same events from the same place - the server derives
   * them from the database rather than from whichever request happened to start
   * the scan - so there is no reason for two copies of this, and a second copy
   * is how a rejoined scan ends up rendering slightly differently.
   */
  const onScanEvent = useCallback((event: ScanEvent) => {
    switch (event.type) {
      case "scan.queued":
        // Waiting for a worker. Saying so beats an idle progress bar, which is
        // indistinguishable from the scan having failed to start.
        setQueued(true);
        break;
      case "scan.started":
        setQueued(false);
        // The full plan arrives up front, so the UI shows every service it
        // intends to scan rather than growing a list as work completes. On a
        // rejoin these carry the statuses they already have.
        setLiveUnits(event.units);
        setProgress({
          completed: event.units.filter((u) => u.status === "succeeded" || u.status === "failed")
            .length,
          total: event.units.length,
        });
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
  }, []);

  const refreshAfterScan = useCallback(
    () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ["latestScan"] }),
        queryClient.invalidateQueries({ queryKey: ["graph"] }),
        queryClient.invalidateQueries({ queryKey: ["summary"] }),
        queryClient.invalidateQueries({ queryKey: ["findings"] }),
      ]),
    [queryClient],
  );

  const runScan = useCallback(async () => {
    setScanning(true);
    setScanError(null);
    setLiveUnits([]);
    setProgress(null);
    setCitedArns([]);

    try {
      await startScan(onScanEvent);
      await refreshAfterScan();
    } catch (err) {
      setScanError(errorMessage(err));
    } finally {
      setScanning(false);
      setQueued(false);
    }
  }, [onScanEvent, refreshAfterScan]);

  /**
   * Rejoin a scan that was already running when this page loaded.
   *
   * The thing the job queue bought. A scan used to live inside the request that
   * started it, so reloading mid-scan orphaned it and left the page showing
   * nothing until it finished. Now the server names the active job and this
   * attaches to it, from wherever it has got to.
   *
   * The ref is what stops it attaching twice: this effect re-runs whenever the
   * `latestScan` query refetches, and without it every refetch would open
   * another stream onto the same scan.
   */
  const watching = useRef<string | null>(null);
  const activeJobId = latest.data?.activeJobId ?? null;

  useEffect(() => {
    if (!activeJobId || scanning || watching.current === activeJobId) return;
    watching.current = activeJobId;
    setScanning(true);
    setScanError(null);

    const controller = new AbortController();
    void (async () => {
      try {
        await watchScan(activeJobId, onScanEvent, controller.signal);
        await refreshAfterScan();
      } catch (err) {
        // An aborted stream is this component unmounting, not a failure.
        if (!controller.signal.aborted) setScanError(errorMessage(err));
      } finally {
        setScanning(false);
        setQueued(false);
        watching.current = null;
      }
    })();

    return () => controller.abort();
  }, [activeJobId, scanning, onScanEvent, refreshAfterScan]);

  /**
   * The privacy policy and the terms, before anything else.
   *
   * Ahead of the signed-out check deliberately: these have to be readable
   * *without* an account, both because Google's consent screen fetches the
   * privacy URL and because being asked to sign in before you can read what a
   * service does with your data is the wrong way round.
   *
   * Pathname matching rather than a router. Two static pages do not justify
   * one, nginx already serves every path to this bundle, and a router would
   * own how the rest of the application navigates.
   */
  const legal = legalPathFor(window.location.pathname);
  if (legal) return <LegalPage path={legal} />;

  /**
   * A signed-out visitor sees the sign-in screen and nothing else.
   *
   * Checked before the first frame rather than after, so there is no flash of
   * an empty application - and so a request is never made on behalf of nobody.
   */
  if (me.data?.hosted && !me.data.signedIn) {
    return <SignIn providers={me.data.providers} invited={invited} />;
  }

  const nodes = shown.nodes;
  const edges = shown.edges;
  const citedOutOfView = citedArns.filter((arn) => !nodes.some((n) => n.arn === arn));
  const presentKinds = [...new Set(nodes.map((n) => n.kind))].sort();

  return (
    <div className="flex h-screen flex-col">
      <ScanBanner
        scan={latest.data?.scan ?? null}
        scanning={scanning}
        queued={queued}
        progress={progress}
        liveUnits={liveUnits}
        error={scanError}
        onScan={() => void runScan()}
        onOpenTrust={() => setModal("trust")}
        onOpenConnection={() => setModal("connection")}
        connections={connections}
        selectedConnectionId={conn}
        onSelectConnection={switchConnection}
        onDisconnectConnection={setDisconnecting}
        signedInAs={me.data?.user?.email ?? null}
        onSignOut={() => {
          void api.logout().then(() => window.location.reload());
        }}
        onDeleteAccount={() => setModal("delete")}
        canScan={can(me.data?.role, "member")}
        {...(me.data?.hosted ? { onOpenTeam: () => setModal("team") } : {})}
      />

      {joinError && (
        <div className="border-b border-danger/30 bg-danger/10 px-3 py-1.5 text-[11px] text-danger">
          The invite could not be accepted: {joinError}
        </div>
      )}

      {modal === "team" && (
        <Modal
          title="Team"
          subtitle="Who can see and change this workspace"
          onClose={() => setModal(null)}
        >
          <Team />
        </Modal>
      )}

      {modal === "delete" && me.data?.user?.email && (
        <Modal
          title="Delete this account"
          subtitle="Everything Sightline holds about you, removed immediately"
          onClose={() => setModal(null)}
        >
          <DeleteAccount
            email={me.data.user.email}
            /**
             * A full reload rather than clearing state.
             *
             * The session row is gone, so every query would now fail; the
             * honest next frame is the sign-in screen, and a reload is the
             * shortest way to one that cannot leave a stale cache behind.
             */
            onDeleted={() => window.location.assign("/")}
          />
        </Modal>
      )}

      {disconnecting && (
        <Modal
          title="Disconnect this account"
          subtitle="Everything Sightline holds about this AWS account, removed"
          onClose={() => setDisconnecting(null)}
        >
          <DisconnectAccount
            connection={disconnecting}
            onDisconnected={() => {
              /**
               * Back to the server's default rather than to another row.
               *
               * `connectionId` may name the account just removed, and a
               * request carrying a dead id is a 404 on every panel at once.
               * Clearing it lets the server pick the oldest remaining
               * connection, which is what a tenant with one account left
               * expects to be looking at.
               */
              setDisconnecting(null);
              setConnectionId(null);
              setCitedArns([]);
              setSelectedArn(null);
              // Everything on screen belonged to an account that no longer
              // exists, `me` included.
              void queryClient.invalidateQueries();
            }}
          />
        </Modal>
      )}

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
          {/*
            `ConnectionGuide` describes the one connection a *process* has and
            reads endpoints a hosted deployment refuses by design, so hosted
            gets the per-connection flow instead. A self-hosted clone keeps the
            guide: its connection genuinely is a property of the deployment, and
            the guide explains the `.env` values that describe it.
          */}
          {me.data?.hosted ? (
            <ConnectAccount
              onConnected={(id) => {
                // The new connection is not in `me` yet, and it is almost
                // certainly what they now want to be looking at.
                void queryClient.invalidateQueries({ queryKey: ["me"] });
                switchConnection(id);
              }}
            />
          ) : (
            <ConnectionGuide />
          )}
        </Modal>
      )}

      <div className="flex min-h-0 flex-1">
        <aside
          aria-label="Findings"
          className="flex w-72 shrink-0 flex-col overflow-hidden border-r border-ink-800 bg-ink-900"
        >
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
          ) : large && group === null ? (
            groups.data ? (
              <GraphGroups
                groups={groups.data.groups}
                total={totalResources}
                onOpen={setGroup}
                cited={citedOutOfView.length}
                onShowCited={() => void expand(citedOutOfView)}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-[12px] text-ink-400">
                Loading groups…
              </div>
            )
          ) : graph.isLoading ? (
            <div className="flex h-full items-center justify-center text-[12px] text-ink-400">
              Loading graph…
            </div>
          ) : graph.error ? (
            <div className="flex h-full flex-col items-center justify-center gap-2">
              <p className="text-[12px] text-danger">
                Could not load the graph: {graph.error.message}
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
              {large && (
                <button
                  onClick={() => {
                    setGroup(null);
                    setExpanded([]);
                  }}
                  className="rounded border border-ink-700 bg-ink-850/95 px-2 py-1 text-[11px] text-ink-300 backdrop-blur transition hover:border-ink-600"
                >
                  ← All groups
                </button>
              )}
              <button
                onClick={() => setShowFilters((v) => !v)}
                className="rounded border border-ink-700 bg-ink-850/95 px-2 py-1 text-[11px] text-ink-300 backdrop-blur transition hover:border-ink-600"
              >
                Filter ({visibleKinds.length}/{presentKinds.length})
              </button>
              {shown.truncated && (
                <span className="rounded bg-ink-850/95 px-2 py-1 text-[11px] text-warn backdrop-blur">
                  {nodes.length} of {shown.total.toLocaleString()}, findings first
                </span>
              )}
              {citedOutOfView.length > 0 && (
                <button
                  onClick={() => void expand(citedOutOfView)}
                  className="rounded border border-accent/50 bg-accent/10 px-2 py-1 text-[11px] text-accent backdrop-blur"
                >
                  Show {citedOutOfView.length} cited
                </button>
              )}
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
              onExpand={(arn) => void expand([arn])}
            />
          </aside>
        )}

        <aside aria-label="Ask" className="w-96 shrink-0 border-l border-ink-800">
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
        Sightline connects to the customer account with a read-only role, discovers what is there,
        and builds a graph of how it fits together. Nothing is ever modified.
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
