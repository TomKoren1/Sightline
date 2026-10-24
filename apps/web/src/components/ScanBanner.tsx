/**
 * Scan state.
 *
 * The UI has to communicate freshness, progress, partial failure
 * and empty states. They are all one component, because they are all the same
 * question from the user's point of view: can I trust what I am looking at?
 */

import type { ScanRun, ScanUnit } from "@sightline/shared";

import { AccountSwitcher } from "./AccountSwitcher.js";
import type { ConnectionSummary } from "../api.js";

/** Beyond this, the inventory is old enough that the user should be told. */
const STALE_AFTER_MS = 60 * 60 * 1000;

function relativeAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export interface ScanBannerProps {
  scan: ScanRun | null;
  scanning: boolean;
  /**
   * Accepted, waiting for a worker to pick it up.
   *
   * Only reachable when scans run in their own process. It earns a distinct
   * state because a progress bar sitting at zero is indistinguishable from a
   * scan that silently failed to start, and "queued" is the difference between
   * waiting and wondering.
   */
  queued: boolean;
  progress: { completed: number; total: number } | null;
  liveUnits: ScanUnit[];
  error: string | null;
  onScan: () => void;
  onOpenTrust: () => void;
  onOpenConnection: () => void;
  connections: ConnectionSummary[];
  /** Null means the server picks the oldest, which is what the switcher shows. */
  selectedConnectionId: string | null;
  onSelectConnection: (id: string) => void;
  /** Asks to remove one account; the confirmation lives in a dialog above. */
  onDisconnectConnection: (connection: ConnectionSummary) => void;
  /** Null in a self-hosted deployment, which has no sign-in. */
  signedInAs: string | null;
  onSignOut: () => void;
  onDeleteAccount: () => void;
  /** Viewers read; scanning needs the member role. */
  canScan: boolean;
  /** Hosted only: who is in the workspace, and inviting more. */
  onOpenTeam?: () => void;
  /** The operator's cross-tenant view; only for the operator's own tenant. */
  onOpenOperator?: () => void;
  /** Every account's findings at once; offered when there is more than one. */
  onOpenAllAccounts?: () => void;
}

export function ScanBanner({
  scan,
  scanning,
  queued,
  progress,
  liveUnits,
  error,
  onScan,
  onOpenTrust,
  onOpenConnection,
  connections,
  selectedConnectionId,
  onSelectConnection,
  onDisconnectConnection,
  signedInAs,
  onSignOut,
  onDeleteAccount,
  canScan,
  onOpenTeam,
  onOpenOperator,
  onOpenAllAccounts,
}: ScanBannerProps) {
  const units = scanning ? liveUnits : (scan?.units ?? []);
  const failed = units.filter((u) => u.status === "failed");
  const stale = scan ? Date.now() - new Date(scan.startedAt).getTime() > STALE_AFTER_MS : false;

  return (
    <div className="border-b border-ink-800 bg-ink-900">
      <div className="flex items-center gap-3 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-semibold text-ink-100">Sightline</span>
          <span className="text-[11px] text-ink-400">AWS inventory</span>
        </div>

        <div className="ml-2 flex-1">
          {scanning ? (
            <div className="flex items-center gap-2">
              <span className="pulse h-1.5 w-1.5 rounded-full bg-accent" />
              <span className="text-[11px] text-ink-300">
                {queued && !progress
                  ? "Queued — waiting for a scanner"
                  : `Scanning${progress ? ` — ${progress.completed}/${progress.total} services` : "…"}`}
              </span>
              <div className="h-1 w-40 overflow-hidden rounded-full bg-ink-800">
                <div
                  className="h-full bg-accent transition-all duration-300"
                  style={{
                    width: progress ? `${(progress.completed / progress.total) * 100}%` : "5%",
                  }}
                />
              </div>
            </div>
          ) : scan ? (
            <div className="flex items-center gap-2 text-[11px]">
              <StatusDot status={scan.status} />
              <span className="text-ink-300">
                {scan.resourceCount} resources across {scan.regions.length} region
                {scan.regions.length === 1 ? "" : "s"}
              </span>
              <span className={stale ? "text-warn" : "text-ink-400"}>
                · scanned {relativeAge(scan.startedAt)}
                {stale && " (stale)"}
              </span>
            </div>
          ) : (
            <span className="text-[11px] text-ink-400">No scan yet</span>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          <AccountSwitcher
            connections={connections}
            selectedId={selectedConnectionId}
            onSelect={onSelectConnection}
            onConnect={onOpenConnection}
            onDisconnect={onDisconnectConnection}
          />
          {signedInAs && (
            <>
              <span className="mx-0.5 h-4 w-px bg-ink-700" aria-hidden />
              {onOpenTeam && (
                <button
                  onClick={onOpenTeam}
                  className="rounded border border-ink-700 bg-ink-800 px-2 py-1 text-[11px] text-ink-300 transition hover:border-ink-600 hover:text-ink-100"
                >
                  Team
                </button>
              )}
              {onOpenAllAccounts && (
                <button
                  onClick={onOpenAllAccounts}
                  className="rounded border border-ink-700 bg-ink-800 px-2 py-1 text-[11px] text-ink-300 transition hover:border-ink-600 hover:text-ink-100"
                >
                  All accounts
                </button>
              )}
              {onOpenOperator && (
                <button
                  onClick={onOpenOperator}
                  className="rounded border border-ink-700 bg-ink-800 px-2 py-1 text-[11px] text-ink-300 transition hover:border-ink-600 hover:text-ink-100"
                >
                  Tenants
                </button>
              )}
              <button
                onClick={onSignOut}
                title={`Signed in as ${signedInAs}`}
                className="rounded border border-ink-700 bg-ink-800 px-2 py-1 text-[11px] text-ink-300 transition hover:border-ink-600 hover:text-ink-100"
              >
                Sign out
              </button>
              {/*
                Next to Sign out, not hidden in a settings page nobody opens.
                A service holding somebody's production inventory should make
                leaving as findable as arriving - and the destructive step is
                behind a dialog that asks them to type their own address, so
                proximity costs nothing.
              */}
              <button
                onClick={onDeleteAccount}
                title="Delete this account and everything Sightline holds about it"
                className="rounded border border-ink-700 bg-ink-800 px-2 py-1 text-[11px] text-ink-400 transition hover:border-danger/60 hover:text-danger"
              >
                Delete account
              </button>
            </>
          )}
          <span className="mx-0.5 h-4 w-px bg-ink-700" aria-hidden />
          <button
            onClick={onOpenConnection}
            className="rounded border border-ink-700 bg-ink-800 px-2 py-1 text-[11px] text-ink-300 transition hover:border-ink-600 hover:text-ink-100"
          >
            Connection
          </button>
          <button
            onClick={onOpenTrust}
            className="rounded border border-ink-700 bg-ink-800 px-2 py-1 text-[11px] text-ink-300 transition hover:border-ink-600 hover:text-ink-100"
          >
            Coverage
          </button>
          <button
            onClick={onScan}
            disabled={scanning || !canScan}
            title={canScan ? undefined : "Scanning needs the member role"}
            className="rounded border border-ink-700 bg-ink-800 px-2.5 py-1 text-[11px] text-ink-100 transition hover:border-ink-600 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {scanning
              ? queued && !progress
                ? "Queued…"
                : "Scanning…"
              : scan
                ? "Rescan"
                : "Run scan"}
          </button>
        </div>
      </div>

      {error && (
        <div className="border-t border-danger/30 bg-danger/10 px-3 py-1.5 text-[11px] text-danger">
          Scan failed: {error}
        </div>
      )}

      {/*
        A partial scan is the state most worth being loud about: the data looks
        complete, and it is not. Each failure names the service, the region and
        what to do about it.
      */}
      {failed.length > 0 && (
        <div className="border-t border-warn/30 bg-warn/10 px-3 py-1.5">
          <p className="text-[11px] font-medium text-warn">
            Partial scan — {failed.length} of {units.length} services failed. Results below are
            incomplete.
          </p>
          <ul className="mt-0.5 space-y-0.5">
            {failed.map((unit) => (
              <li key={`${unit.service}-${unit.region}`} className="text-[10px] text-warn/80">
                <span className="font-mono">
                  {unit.service}/{unit.region ?? "global"}
                </span>
                {unit.error ? ` — ${unit.error}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === "succeeded"
      ? "bg-good"
      : status === "partial"
        ? "bg-warn"
        : status === "running"
          ? "bg-accent"
          : "bg-danger";
  return <span className={`h-1.5 w-1.5 rounded-full ${color}`} role="img" aria-label={status} />;
}
