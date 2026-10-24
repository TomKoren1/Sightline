/**
 * What the last scan could see: every service in every region it read, what it
 * could not read and why, and what Sightline never reads at all.
 *
 * The evidence that matters for a real account. A finding list is only as
 * complete as the scan behind it, and "no public buckets" from a scan that was
 * refused S3 is not the same claim as from one that read every bucket.
 */

import { GLOBAL_SERVICES, SERVICE_LABELS, type ScanRun, type ScanUnit } from "@sightline/shared";

/** Never collected, by design: the role can list and describe, not read data. */
const NEVER_READ = [
  "Objects in S3 buckets, and anything stored in a database",
  "Secret values in Secrets Manager or Parameter Store",
  "Logs, metrics and CloudTrail history",
  "Anything that would need write access: the role is read-only",
];

function ago(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function Cell({ unit }: { unit: ScanUnit | undefined }) {
  if (!unit) return <td className="px-1.5 py-0.5 text-center text-ink-600">·</td>;
  if (unit.status === "failed") {
    return (
      <td className="px-1.5 py-0.5 text-center font-medium text-danger" title={unit.error}>
        ✕
      </td>
    );
  }
  return (
    <td
      className="px-1.5 py-0.5 text-center text-ink-300"
      title={`${unit.resourceCount} resources, ${unit.apiCalls} calls`}
    >
      {unit.resourceCount}
    </td>
  );
}

export function ScanCoverage({ scan }: { scan: ScanRun | null }) {
  if (!scan) {
    return <p className="text-[12px] text-ink-400">No scan has finished yet.</p>;
  }
  const units = scan.units;
  const read = units.filter((u) => u.status === "succeeded").length;
  const failed = units.filter((u) => u.status === "failed");
  const regional = [...new Set(units.filter((u) => u.region).map((u) => u.service))];
  const global = units.filter((u) => GLOBAL_SERVICES.has(u.service) || u.region === null);
  const at = (service: string, region: string) =>
    units.find((u) => u.service === service && u.region === region);

  return (
    <div className="space-y-4 text-[12px]">
      <p className="text-ink-300">
        Scanned {ago(scan.finishedAt ?? scan.startedAt)} · {scan.resourceCount.toLocaleString()}{" "}
        resources ·{" "}
        <span className={failed.length > 0 ? "text-warn" : "text-ink-100"}>
          {read} of {units.length} service checks read
        </span>
      </p>

      {failed.length > 0 && (
        <section className="rounded border border-warn/40 bg-warn/5 p-2.5">
          <h4 className="mb-1 font-semibold text-warn">
            Not read: findings for these are missing, not clear
          </h4>
          <ul className="space-y-1 text-[11px] text-ink-300">
            {failed.map((u) => (
              <li key={`${u.service}:${u.region ?? "global"}`}>
                <span className="font-medium text-ink-100">
                  {SERVICE_LABELS[u.service]} {u.region ? `in ${u.region}` : ""}
                </span>
                {u.error ? ` — ${u.error}` : ""}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h4 className="mb-1 font-semibold text-ink-100">Resources found, by service and region</h4>
        <div className="overflow-x-auto rounded border border-ink-800">
          <table className="w-full text-[11px]">
            <thead className="text-ink-400">
              <tr>
                <th className="px-2 py-1 text-left font-medium">Service</th>
                {scan.regions.map((r) => (
                  <th key={r} className="px-1.5 py-1 text-center font-medium">
                    {r}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-800">
              {regional.map((service) => (
                <tr key={service}>
                  <td className="px-2 py-0.5 text-ink-100">{SERVICE_LABELS[service]}</td>
                  {scan.regions.map((r) => (
                    <Cell key={r} unit={at(service, r)} />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {global.length > 0 && (
          <p className="mt-1.5 text-[11px] text-ink-400">
            Global:{" "}
            {global.map((u, i) => (
              <span key={u.service} className={u.status === "failed" ? "text-danger" : ""}>
                {i > 0 && " · "}
                {SERVICE_LABELS[u.service]}{" "}
                {u.status === "failed" ? "not read" : u.resourceCount.toLocaleString()}
              </span>
            ))}
          </p>
        )}
      </section>

      <section>
        <h4 className="mb-1 font-semibold text-ink-100">Never read, by design</h4>
        <ul className="list-inside list-disc space-y-0.5 text-[11px] text-ink-400">
          {NEVER_READ.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}
