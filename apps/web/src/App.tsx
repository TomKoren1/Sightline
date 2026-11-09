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

import { api, can, selectConnection } from "./api.js";
import { Team } from "./components/Team.js";
import { OperatorView } from "./components/OperatorView.js";
import { AllAccounts } from "./components/AllAccounts.js";
import type { ConnectionSummary } from "./api.js";
import { GraphGroups } from "./components/GraphGroups.js";
import { DEFAULT_VISIBLE_KINDS, KIND_STYLES, styleFor } from "./kinds.js";
import { Chat } from "./components/Chat.js";
import { ConnectAccount } from "./components/ConnectAccount.js";
import { ConnectionGuide } from "./components/ConnectionGuide.js";
import { DeleteAccount } from "./components/DeleteAccount.js";
import { DisconnectAccount } from "./components/DisconnectAccount.js";
import { Modal } from "./components/Modal.js";
import { TrustPanel } from "./components/TrustPanel.js";
import { FixPlan } from "./components/FixPlan.js";
import { Findings } from "./components/Findings.js";
import { GraphView } from "./components/GraphView.js";
import { LegalPage, legalPathFor } from "./components/LegalPage.js";
import { ResourceDetail } from "./components/ResourceDetail.js";
import { ResourceSearch } from "./components/ResourceSearch.js";
import { ScanBanner } from "./components/ScanBanner.js";
import { useScanSession } from "./hooks/useScanSession.js";
import { useAccountGraph } from "./hooks/useAccountGraph.js";
import { useTeamJoin } from "./hooks/useTeamJoin.js";
import { SignIn } from "./components/SignIn.js";

export function App() {
  const queryClient = useQueryClient();

  /** Accepted, but no worker has picked it up yet. */

  const [citedArns, setCitedArns] = useState<string[]>([]);
  const clearCitations = useCallback(() => setCitedArns([]), []);
  const [selectedArn, setSelectedArn] = useState<string | null>(null);
  const [visibleKinds, setVisibleKinds] = useState<string[]>(DEFAULT_VISIBLE_KINDS);
  const [showFilters, setShowFilters] = useState(false);
  const [modal, setModal] = useState<
    "trust" | "fixplan" | "connection" | "delete" | "team" | "operator" | "accounts" | null
  >(null);
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

  const { invited, joinError } = useTeamJoin(Boolean(me.data?.hosted && me.data.signedIn));

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

  const {
    summary,
    totalResources,
    findings,
    large,
    group,
    openGroup,
    backToGroups,
    graph,
    groups,
    shown,
    expand,
  } = useAccountGraph(conn, hasScan);

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

  const { scanning, queued, progress, liveUnits, scanError, runScan } = useScanSession(
    latest.data?.activeJobId ?? null,
    clearCitations,
  );

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
        onOpenFixPlan={() => setModal("fixplan")}
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
        {...((me.data?.connections.length ?? 0) > 1
          ? { onOpenAllAccounts: () => setModal("accounts") }
          : {})}
        {...(me.data?.hosted && me.data.isAdmin && can(me.data.role, "admin")
          ? { onOpenOperator: () => setModal("operator") }
          : {})}
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

      {modal === "accounts" && (
        <Modal
          title="All accounts"
          subtitle="Open findings in every connected account, worst first"
          onClose={() => setModal(null)}
        >
          <AllAccounts
            onOpen={(connectionId, arn) => {
              switchConnection(connectionId);
              setSelectedArn(arn);
              setModal(null);
            }}
          />
        </Modal>
      )}

      {modal === "operator" && (
        <Modal
          title="Tenants"
          subtitle="Every workspace's scans and usage, for support"
          onClose={() => setModal(null)}
        >
          <OperatorView />
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

      {modal === "fixplan" && (
        <Modal
          title="Fix plan"
          subtitle="Every computed fix for the open findings, to choose from and run yourself"
          onClose={() => setModal(null)}
        >
          <FixPlan />
        </Modal>
      )}

      {modal === "trust" && (
        <Modal
          title="What the last scan could see"
          subtitle="What was read, what could not be, and what Sightline never reads"
          onClose={() => setModal(null)}
        >
          <TrustPanel
            scan={latest.data?.scan ?? null}
            demo={connections.find((c) => c.id === conn)?.kind === "demo"}
          />
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
          {hasScan && (
            <ResourceSearch
              onPick={(arn) => {
                setSelectedArn(arn);
                setCitedArns([arn]);
              }}
            />
          )}
          <Findings
            summary={summary.data}
            findings={findings.data}
            loading={hasScan && (summary.isLoading || findings.isLoading)}
            onHighlight={(arns) => {
              setCitedArns(arns);
              // One resource is a finding chosen: open it, which is where its fixes are.
              if (arns.length === 1) setSelectedArn(arns[0]!);
            }}
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
                onOpen={openGroup}
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
                  onClick={backToGroups}
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
          <aside aria-label="Resource" className="w-80 shrink-0">
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
