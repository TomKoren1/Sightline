/**
 * The signed-in person's menu: the team, the operator's tenants, signing out
 * and deleting the account. One button in the header instead of four, so the
 * header keeps to what is done every day - the account, coverage, fixes, scan.
 *
 * Deleting stays one click from signing out, as findable as arriving was; the
 * dialog behind it still asks for the address typed out.
 */

import { useEffect, useRef, useState } from "react";

interface Props {
  signedInAs: string;
  onOpenTeam?: () => void;
  onOpenOperator?: () => void;
  onSignOut: () => void;
  onDeleteAccount: () => void;
}

const base =
  "block w-full px-3 py-1.5 text-left text-[12px] hover:bg-ink-800 focus:bg-ink-800 focus:outline-none";
const item = `${base} text-ink-300 hover:text-ink-100`;

export function AccountMenu({
  signedInAs,
  onOpenTeam,
  onOpenOperator,
  onSignOut,
  onDeleteAccount,
}: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (
        e instanceof KeyboardEvent ? e.key === "Escape" : !root.current?.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const choose = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  return (
    <div ref={root} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-1 rounded border border-ink-700 bg-ink-800 px-2 py-1 text-[11px] text-ink-300 transition hover:border-ink-600 hover:text-ink-100"
      >
        <span className="max-w-[14rem] truncate">{signedInAs}</span>
        <span aria-hidden>▾</span>
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Account"
          className="absolute right-0 z-30 mt-1 w-48 overflow-hidden rounded border border-ink-700 bg-ink-900 py-1 shadow-lg"
        >
          {onOpenTeam && (
            <button role="menuitem" className={item} onClick={choose(onOpenTeam)}>
              Team
            </button>
          )}
          {onOpenOperator && (
            <button role="menuitem" className={item} onClick={choose(onOpenOperator)}>
              Tenants
            </button>
          )}
          <button role="menuitem" className={item} onClick={choose(onSignOut)}>
            Sign out
          </button>
          <div className="my-1 h-px bg-ink-800" aria-hidden />
          <button
            role="menuitem"
            className={`${base} text-ink-400 hover:text-danger`}
            title="Delete this account and everything Sightline holds about it"
            onClick={choose(onDeleteAccount)}
          >
            Delete account
          </button>
        </div>
      )}
    </div>
  );
}
