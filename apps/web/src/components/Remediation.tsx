/**
 * The fix, written out, with a copy button and no way to apply it.
 *
 * The absence of an "Apply" button is the feature. Everything else in this
 * product argues that Sightline holds read-only access by design; a panel that
 * offered to run these would undo that argument in one click, and the honest
 * version — telling you precisely what to change and refusing to change it — is
 * both safer and more useful, because the person who understands the blast
 * radius is the one at the keyboard.
 *
 * Two deliberate choices in the layout:
 *
 * The **caution comes before the commands**, not after. A caution below a copy
 * button is read second, and by then the command is already on the clipboard.
 *
 * The **risk badge is not decoration**. An unprotected bucket rates low because
 * nothing can currently reach it, and a genuinely public one rates high; if
 * everything were red the rating would carry no information and people would
 * stop reading it.
 */

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Copyable } from "./Copyable.js";

interface Remediation {
  id: string;
  addresses: "public" | "unprotected" | "admin" | "exposed" | "idle";
  title: string;
  summary: string;
  caution: string;
  risk: "low" | "medium" | "high";
  cli: string[];
  terraform?: string;
  verify?: string;
}

interface RemediationResponse {
  arn: string;
  remediations: Remediation[];
  note: string;
}

const RISK_STYLE: Record<Remediation["risk"], { chip: string; label: string }> = {
  low: { chip: "border-good/40 bg-good/10 text-good", label: "low risk" },
  medium: { chip: "border-warn/40 bg-warn/10 text-warn", label: "medium risk" },
  high: { chip: "border-danger/40 bg-danger/10 text-danger", label: "high risk" },
};

function RemediationCard({ remediation }: { remediation: Remediation }) {
  const [showTerraform, setShowTerraform] = useState(false);
  const risk = RISK_STYLE[remediation.risk];

  return (
    <div className="rounded border border-ink-700 bg-ink-850">
      <div className="flex items-start justify-between gap-2 border-b border-ink-800 px-2 py-1.5">
        <span className="text-[11px] font-semibold text-ink-100">{remediation.title}</span>
        <span
          className={`shrink-0 rounded border px-1 py-0.5 text-[9px] uppercase tracking-wide ${risk.chip}`}
        >
          {risk.label}
        </span>
      </div>

      <div className="space-y-2 px-2 py-2">
        <p className="text-[11px] leading-relaxed text-ink-300">{remediation.summary}</p>

        {/* Before the commands, deliberately — see the note at the top. */}
        <div className="rounded border border-warn/30 bg-warn/5 px-2 py-1.5">
          <div className="mb-0.5 text-[9px] font-semibold uppercase tracking-wider text-warn">
            What this could break
          </div>
          <p className="text-[10px] leading-relaxed text-ink-300">{remediation.caution}</p>
        </div>

        <Copyable value={remediation.cli.join("\n")} label="Run this yourself" />

        {remediation.verify && (
          <Copyable value={remediation.verify} label="Confirm it worked (read-only)" />
        )}

        {remediation.terraform && (
          <div>
            <button
              onClick={() => setShowTerraform((v) => !v)}
              className="text-[10px] text-ink-400 transition hover:text-ink-100"
            >
              {showTerraform ? "− hide" : "+ show"} Terraform equivalent
            </button>
            {showTerraform && (
              <div className="mt-1">
                <Copyable value={remediation.terraform} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function Remediation({ arn, hasFindings }: { arn: string; hasFindings: boolean }) {
  const { data, isLoading } = useQuery({
    queryKey: ["remediation", arn],
    queryFn: async () => {
      const res = await fetch(`/api/resources/${encodeURIComponent(arn)}/remediation`);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return res.json() as Promise<RemediationResponse>;
    },
    // A resource with no verdict has nothing to fix, so do not ask.
    enabled: hasFindings,
  });

  if (!hasFindings) return null;
  if (isLoading) return <div className="h-16 animate-pulse rounded bg-ink-850" />;
  if (!data || data.remediations.length === 0) return null;

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-400">
          How to fix
        </div>
        <span className="text-[9px] text-ink-400">Sightline will never run these</span>
      </div>
      <div className="space-y-2">
        {data.remediations.map((r) => (
          <RemediationCard key={r.id} remediation={r} />
        ))}
      </div>
    </div>
  );
}
