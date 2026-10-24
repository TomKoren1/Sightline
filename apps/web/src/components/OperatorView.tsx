/** Every tenant at a glance, worst first: failing scans, then the newest. */

import { useQuery } from "@tanstack/react-query";

import { api } from "../api.js";

export function OperatorView() {
  const tenants = useQuery({ queryKey: ["operatorTenants"], queryFn: api.operatorTenants });
  if (tenants.isLoading) return <div className="h-40 animate-pulse rounded bg-ink-850" />;
  if (tenants.error) return <p className="text-[12px] text-danger">{tenants.error.message}</p>;
  const rows = tenants.data?.tenants ?? [];
  return (
    <div className="max-h-[60vh] overflow-auto text-[11px]">
      <table className="w-full">
        <thead className="sticky top-0 bg-ink-900 text-left text-ink-400">
          <tr>
            <th className="px-2 py-1.5 font-medium">Workspace</th>
            <th className="px-2 py-1.5 font-medium">Accounts</th>
            <th className="px-2 py-1.5 font-medium">Scans 7 d</th>
            <th className="px-2 py-1.5 font-medium">Last scan</th>
            <th className="px-2 py-1.5 font-medium">Questions / tokens 24 h</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-800">
          {rows.map((t) => (
            <tr key={t.id} className="align-top">
              <td className="px-2 py-1.5">
                <p className="text-ink-100">{t.name}</p>
                <p className="font-mono text-ink-400">{t.id.slice(0, 8)}</p>
              </td>
              <td className="px-2 py-1.5 text-ink-300">{t.connections}</td>
              <td className="px-2 py-1.5">
                <span className="text-ink-300">{t.scansSucceeded7d} ok</span>
                {t.scansFailed7d > 0 && (
                  <span className="ml-1 text-danger">{t.scansFailed7d} failed</span>
                )}
                {t.activeScans > 0 && (
                  <span className="ml-1 text-accent">{t.activeScans} active</span>
                )}
              </td>
              <td className="px-2 py-1.5 text-ink-300">
                {t.lastScan ? (
                  <>
                    <p>
                      {t.lastScan.status}
                      {t.lastScan.at ? ` · ${new Date(t.lastScan.at).toLocaleString()}` : ""}
                    </p>
                    {t.lastScan.error && (
                      <p className="max-w-xs break-words text-danger">{t.lastScan.error}</p>
                    )}
                  </>
                ) : (
                  <span className="text-ink-400">never</span>
                )}
              </td>
              <td className="px-2 py-1.5 text-ink-300">
                {t.questions24h} / {t.tokens24h.toLocaleString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
