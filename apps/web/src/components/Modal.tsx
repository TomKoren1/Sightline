/** Overlay panel. Closes on backdrop click or Escape. */

import { useEffect, type ReactNode } from "react";

export function Modal({
  title,
  subtitle,
  onClose,
  children,
  width = "max-w-3xl",
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  width?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-6 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        className={`w-full ${width} rounded-lg border border-ink-700 bg-ink-900 shadow-2xl`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="flex items-start justify-between gap-3 border-b border-ink-800 px-4 py-3">
          <div>
            <h2 className="text-[13px] font-semibold text-ink-100">{title}</h2>
            {subtitle && <p className="mt-0.5 text-[11px] text-ink-400">{subtitle}</p>}
          </div>
          <button
            onClick={onClose}
            className="shrink-0 rounded px-1.5 text-ink-400 transition hover:text-ink-100"
            aria-label="Close"
          >
            ✕
          </button>
        </header>
        <div className="max-h-[75vh] overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}
