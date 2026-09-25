/**
 * A command block with a copy button.
 *
 * Extracted from the connection guide when remediation needed the same thing.
 * Both places exist for the same reason — this product hands people commands to
 * run rather than running them — so they should look and behave identically.
 */

import { useState } from "react";

export function Copyable({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      {/*
        The button sits above the block, not floating over it.
        It used to be absolutely positioned inside the `<pre>` with `pr-16` to
        reserve room. That works while the block is wide, and fails in a narrow
        panel: the `<pre>` scrolls horizontally, padding scrolls with the
        content, and the button ends up sitting on top of the command text with
        a character or two visible past it. A copy button that obscures the
        thing being copied is a bad joke in a feature whose whole purpose is
        handing people exact commands (engineering log #34).
      */}
      <div className="mb-0.5 flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-[10px] text-ink-400">{label ?? ""}</span>
        <button
          onClick={() => {
            // Clipboard access needs a secure context, which http://<tailnet-ip>
            // is not. Selecting the text is the honest fallback.
            navigator.clipboard?.writeText(value).then(
              () => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              },
              () => setCopied(false),
            );
          }}
          className="shrink-0 rounded border border-ink-700 bg-ink-800 px-1.5 py-0.5 text-[10px] text-ink-300 transition hover:border-ink-600 hover:text-ink-100"
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <pre className="overflow-x-auto rounded border border-ink-700 bg-ink-950 px-2 py-1.5 font-mono text-[10px] leading-relaxed text-ink-100">
        {value}
      </pre>
    </div>
  );
}
