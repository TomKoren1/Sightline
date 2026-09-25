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
    <div className="group relative">
      {label && <div className="mb-0.5 text-[10px] text-ink-400">{label}</div>}
      <pre className="overflow-x-auto rounded border border-ink-700 bg-ink-950 px-2 py-1.5 pr-16 font-mono text-[10px] leading-relaxed text-ink-100">
        {value}
      </pre>
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
        className="absolute right-1.5 top-[1.6rem] rounded border border-ink-700 bg-ink-800 px-1.5 py-0.5 text-[10px] text-ink-300 transition hover:border-ink-600 hover:text-ink-100"
        style={label ? undefined : { top: "0.35rem" }}
      >
        {copied ? "copied" : "copy"}
      </button>
    </div>
  );
}
