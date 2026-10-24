/**
 * Which of your AWS accounts you are looking at.
 *
 * Replaces the demo/real toggle, which was process-wide: one person clicking it
 * would have changed what every other tenant on that process was looking at,
 * and which account their next scan read. This is a selection among rows that
 * already belong to you, carried as a request header.
 *
 * Switching does **not** rescan. The graph keeps showing the previous account's
 * inventory until one runs, and the banner says so rather than letting anyone
 * read one account's resources under another's name — the one piece of the old
 * toggle's behaviour that was always right.
 */

import { useState } from "react";

import type { ConnectionSummary } from "../api.js";

const STATUS_LABEL: Record<ConnectionSummary["status"], string> = {
  verified: "connected",
  pending: "not connected yet",
  failed: "connection failed",
  disconnected: "disconnected",
};

const STATUS_COLOUR: Record<ConnectionSummary["status"], string> = {
  verified: "text-ink-400",
  pending: "text-warn",
  failed: "text-danger",
  disconnected: "text-ink-400",
};

export function AccountSwitcher({
  connections,
  selectedId,
  onSelect,
  onConnect,
  onDisconnect,
}: {
  connections: ConnectionSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onConnect: () => void;
  onDisconnect: (connection: ConnectionSummary) => void;
}) {
  const [open, setOpen] = useState(false);

  // No header sent means the server picks the oldest account, so that is what
  // is shown as selected rather than leaving the control blank. An
  // organization holds no inventory of its own, so it is never the selection
  // unless it is all there is yet.
  const accounts = connections.filter((c) => c.kind !== "organization");
  const selected =
    accounts.find((c) => c.id === selectedId) ?? accounts[0] ?? connections[0] ?? null;
  // Each organization followed by the accounts it found.
  const ordered = connections
    .filter((c) => !c.parentId)
    .flatMap((c) => [c, ...connections.filter((child) => child.parentId === c.id)]);

  if (!selected) {
    return (
      <button
        onClick={onConnect}
        className="rounded border border-accent/50 bg-accent/10 px-2 py-1 text-[11px] text-accent transition hover:bg-accent/20"
      >
        Connect an AWS account
      </button>
    );
  }

  return (
    <div className="relative flex items-center gap-1.5">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded border border-ink-700 bg-ink-800 px-2 py-1 text-[11px] text-ink-100 transition hover:border-ink-600"
        title={selected.roleArn ?? selected.label}
      >
        <span>{selected.label}</span>
        {selected.kind === "demo" && (
          <span className="rounded bg-ink-700 px-1 text-[10px] text-ink-300">demo</span>
        )}
        <span className="text-[10px] text-ink-400">▾</span>
      </button>

      <span className={`text-[10px] ${STATUS_COLOUR[selected.status]}`}>
        {selected.accountId ?? STATUS_LABEL[selected.status]}
      </span>

      {open && (
        <>
          {/* Clicking anywhere else closes it, without a global listener. */}
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute left-0 top-full z-20 mt-1 w-72 overflow-hidden rounded border border-ink-700 bg-ink-850 shadow-lg">
            {ordered.map((connection) => (
              /*
                A row rather than a single button, because it carries two
                actions now and a button inside a button is invalid markup -
                which browsers resolve by dropping one of the click handlers,
                silently and not always the same one.
              */
              <div
                key={connection.id}
                className={`flex items-start transition hover:bg-ink-800 ${
                  connection.id === selected.id ? "bg-ink-800" : ""
                }`}
              >
                <button
                  disabled={connection.kind === "organization"}
                  onClick={() => {
                    setOpen(false);
                    if (connection.id !== selected.id) onSelect(connection.id);
                  }}
                  className={`flex min-w-0 flex-1 flex-col items-start gap-0.5 py-1.5 text-left disabled:cursor-default ${
                    connection.parentId ? "pl-6 pr-2.5" : "px-2.5"
                  }`}
                >
                  <span className="flex w-full items-center gap-1.5">
                    <span className="text-[11px] text-ink-100">{connection.label}</span>
                    {connection.kind === "demo" && (
                      <span className="rounded bg-ink-700 px-1 text-[10px] text-ink-300">demo</span>
                    )}
                    {connection.kind === "organization" && (
                      <span className="rounded bg-ink-700 px-1 text-[10px] text-ink-300">
                        organization ·{" "}
                        {connections.filter((c) => c.parentId === connection.id).length} accounts
                      </span>
                    )}
                    {connection.id === selected.id && (
                      <span className="ml-auto text-[10px] text-accent">current</span>
                    )}
                  </span>
                  <span className={`text-[10px] ${STATUS_COLOUR[connection.status]}`}>
                    {connection.accountId ?? STATUS_LABEL[connection.status]}
                  </span>
                  {connection.lastError && (
                    <span className="line-clamp-2 text-[10px] text-danger">
                      {connection.lastError}
                    </span>
                  )}
                </button>

                {/*
                  Not offered for the demo fixture: it belongs to the
                  deployment rather than to a tenant, and a self-hosted clone
                  recreates it on the next boot - so removing it would look
                  like a bug in either direction.

                  Always visible rather than revealed on hover. A control that
                  appears on hover does not exist on a touch screen, and this
                  is the only way to remove an account.
                */}
                {connection.kind !== "demo" && (
                  <button
                    onClick={() => {
                      setOpen(false);
                      onDisconnect(connection);
                    }}
                    title={`Disconnect ${connection.label}`}
                    aria-label={`Disconnect ${connection.label}`}
                    className="mr-1 mt-1.5 shrink-0 rounded px-1.5 py-0.5 text-[11px] leading-none text-ink-400 transition hover:bg-danger/15 hover:text-danger"
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
            <button
              onClick={() => {
                setOpen(false);
                onConnect();
              }}
              className="w-full border-t border-ink-700 px-2.5 py-1.5 text-left text-[11px] text-accent transition hover:bg-ink-800"
            >
              Connect another account…
            </button>
          </div>
        </>
      )}
    </div>
  );
}
