/** Every connected account's open findings: counts per account, then the worst, across all. */

import { useQuery } from "@tanstack/react-query";

import { api, type FindingCategory } from "../api.js";

const LABELS: Record<FindingCategory, string> = {
  exposed: "Exposed",
  admin: "Admin",
  unused: "Unused",
  unguarded: "Unguarded",
  idle: "Idle",
};
const ORDER: FindingCategory[] = ["exposed", "admin", "unused", "unguarded", "idle"];

export function AllAccounts({ onOpen }: { onOpen: (connectionId: string, arn: string) => void }) {
  const data = useQuery({ queryKey: ["findingsAcross"], queryFn: api.findingsAcrossAccounts });
  if (data.isLoading) return <div className="h-40 animate-pulse rounded bg-ink-850" />;
  if (data.error) return <p className="text-[12px] text-danger">{data.error.message}</p>;
  const { accounts, findings } = data.data ?? { accounts: [], findings: [] };
  const labelOf = new Map(accounts.map((a) => [a.connectionId, a.label]));

  return (
    <div className="flex max-h-[65vh] flex-col gap-4 overflow-auto text-[11px]">
      <table className="w-full">
        <thead className="text-left text-ink-400">
          <tr>
            <th className="px-2 py-1 font-medium">Account</th>
            {ORDER.map((c) => (
              <th key={c} className="px-2 py-1 text-right font-medium">
                {LABELS[c]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-800">
          {accounts.map((a) => (
            <tr key={a.connectionId}>
              <td className="px-2 py-1">
                <span className="text-ink-100">{a.label}</span>
                {a.accountId && (
                  <span className="ml-1.5 font-mono text-ink-400">{a.accountId}</span>
                )}
              </td>
              {ORDER.map((c) => (
                <td
                  key={c}
                  className={`px-2 py-1 text-right ${a.open[c] > 0 && c === "exposed" ? "text-danger" : "text-ink-300"}`}
                >
                  {a.open[c]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      <section>
        <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-400">
          Worst first
        </h3>
        {findings.length === 0 ? (
          <p className="text-ink-400">No open findings in any account.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-ink-800 rounded border border-ink-800">
            {findings.map((f) => (
              <li key={f.id}>
                <button
                  onClick={() => onOpen(f.connectionId, f.arn)}
                  className="w-full px-2.5 py-1.5 text-left hover:bg-ink-850"
                >
                  <p className="truncate text-ink-100">
                    <span className="mr-1.5 text-ink-400">{LABELS[f.category]}</span>
                    {f.name}
                    <span className="ml-1.5 text-ink-400">in {labelOf.get(f.connectionId)}</span>
                  </p>
                  {f.reason && <p className="truncate text-ink-400">{f.reason}</p>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
