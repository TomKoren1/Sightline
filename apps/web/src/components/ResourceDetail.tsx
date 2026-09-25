/** Detail panel for a selected node. */

import { useQuery } from "@tanstack/react-query";

import { Remediation } from "./Remediation.js";
import { styleFor } from "../kinds.js";

interface Neighbour {
  type: string | null;
  arn: string | null;
  name: string | null;
  kind: string | null;
}

interface ResourceDetailResponse {
  resource: {
    arn: string;
    kind: string;
    name: string;
    region: string | null;
    props: Record<string, unknown>;
    outgoing: Neighbour[];
    incoming: Neighbour[];
  };
}

/** Internal bookkeeping the user does not need to see. */
const HIDDEN_PROPS = new Set(["arn", "kind", "name", "region", "accountId", "scanId", "tagsJson"]);

export function ResourceDetail({
  arn,
  onClose,
  onSelect,
}: {
  arn: string;
  onClose: () => void;
  onSelect: (arn: string) => void;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["resource", arn],
    queryFn: async () => {
      const res = await fetch(`/api/resources/${encodeURIComponent(arn)}`);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return res.json() as Promise<ResourceDetailResponse>;
    },
  });

  const resource = data?.resource;
  const style = resource ? styleFor(resource.kind) : null;

  const neighbours = [
    ...(resource?.outgoing ?? []).map((n) => ({ ...n, direction: "→" as const })),
    ...(resource?.incoming ?? []).map((n) => ({ ...n, direction: "←" as const })),
  ].filter((n) => n.arn);

  return (
    <div className="flex h-full flex-col border-l border-ink-800 bg-ink-900">
      <header className="flex items-start justify-between gap-2 border-b border-ink-800 px-3 py-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            {style && (
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: style.color }}
                aria-hidden
              />
            )}
            <span className="truncate text-[12px] font-semibold text-ink-100">
              {resource?.name ?? "Loading…"}
            </span>
          </div>
          <div className="mt-0.5 text-[10px] text-ink-400">
            {style?.label}
            {resource?.region ? ` · ${resource.region}` : ""}
          </div>
        </div>
        <button onClick={onClose} className="shrink-0 text-ink-400 hover:text-ink-100">
          ✕
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-2.5">
        {isLoading && <div className="h-20 animate-pulse rounded bg-ink-850" />}
        {error && <p className="text-[12px] text-danger">{(error as Error).message}</p>}

        {resource && (
          <div className="space-y-3">
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-400">
                ARN
              </div>
              <div className="break-all rounded bg-ink-850 px-2 py-1 font-mono text-[10px] text-ink-300">
                {resource.arn}
              </div>
            </div>

            {/* Security verdicts first: they are why someone opened this panel. */}
            {["isPublic", "isAdmin", "isIdle", "isUnprotected"].some(
              (k) => resource.props[k] === true,
            ) && (
              <div className="space-y-1">
                {resource.props["isPublic"] === true && (
                  <Verdict
                    tone="danger"
                    label="Reachable from the internet"
                    reason={String(resource.props["publicReason"] ?? "")}
                  />
                )}
                {resource.props["isAdmin"] === true && (
                  <Verdict
                    tone="warn"
                    label="Administrator access"
                    reason={String(resource.props["adminReason"] ?? "")}
                  />
                )}
                {resource.props["isUnprotected"] === true && (
                  <Verdict
                    tone="warn"
                    label="Block Public Access not fully enabled"
                    reason={String(resource.props["unprotectedReason"] ?? "")}
                  />
                )}
                {resource.props["isIdle"] === true && (
                  <Verdict
                    tone="ink"
                    label={`Idle${
                      resource.props["estimatedMonthlyCostUsd"]
                        ? ` · ~$${resource.props["estimatedMonthlyCostUsd"]}/mo`
                        : ""
                    }`}
                    reason={String(resource.props["idleReason"] ?? "")}
                  />
                )}
              </div>
            )}

            {/* Directly under the verdicts: someone who has just read "reachable
                from the internet" wants the fix next, not the property list. */}
            <Remediation
              arn={resource.arn}
              hasFindings={["isPublic", "isAdmin", "isIdle", "isUnprotected"].some(
                (k) => resource.props[k] === true,
              )}
            />

            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-400">
                Properties
              </div>
              <div className="space-y-0.5">
                {Object.entries(resource.props)
                  .filter(
                    ([k, v]) =>
                      !HIDDEN_PROPS.has(k) &&
                      !k.startsWith("tag_") &&
                      !k.endsWith("Reason") &&
                      v !== null &&
                      v !== "",
                  )
                  .map(([key, value]) => (
                    <div key={key} className="flex items-start justify-between gap-2 text-[11px]">
                      <span className="shrink-0 text-ink-400">{key}</span>
                      <span className="break-all text-right font-mono text-[10px] text-ink-300">
                        {typeof value === "object" ? JSON.stringify(value) : String(value)}
                      </span>
                    </div>
                  ))}
              </div>
            </div>

            {neighbours.length > 0 && (
              <div>
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-400">
                  Connections
                </div>
                <div className="space-y-0.5">
                  {neighbours.map((n, i) => (
                    <button
                      key={`${n.arn}-${n.type}-${i}`}
                      onClick={() => n.arn && onSelect(n.arn)}
                      className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] transition hover:bg-ink-850"
                    >
                      <span className="text-ink-400">{n.direction}</span>
                      <span className="font-mono text-[9px] text-ink-400">{n.type}</span>
                      <span className="truncate text-ink-300">{n.name ?? n.arn}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Verdict({
  tone,
  label,
  reason,
}: {
  tone: "danger" | "warn" | "ink";
  label: string;
  reason: string;
}) {
  const classes = {
    danger: "border-danger/40 bg-danger/10 text-danger",
    warn: "border-warn/40 bg-warn/10 text-warn",
    ink: "border-ink-700 bg-ink-850 text-ink-300",
  }[tone];
  return (
    <div className={`rounded border px-2 py-1.5 ${classes}`}>
      <div className="text-[11px] font-medium">{label}</div>
      {reason && <div className="mt-0.5 text-[10px] leading-snug opacity-80">{reason}</div>}
    </div>
  );
}
