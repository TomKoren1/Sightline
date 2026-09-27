/**
 * The Trust panel.
 *
 * "How much should I trust this?" is a fair question from someone about to act
 * on an answer, and it deserves an answer inside the product rather than in a
 * README nobody opens. Two tiers, matching ADR-008 and deliberately presented
 * as different kinds of evidence:
 *
 *   - **Data checks** validate the inventory the UI is currently showing. They
 *     need no model and no API key, run in milliseconds, and can be re-run
 *     here on demand - so this is live evidence, not a stored claim.
 *
 *   - **Agent evals** score the answers themselves. They cost money to
 *     produce, so the last recorded run is displayed rather than re-run from a
 *     button a visitor might click repeatedly.
 */

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";

import { api, type CheckResult, type GroundTruthRun } from "../api.js";

export function TrustPanel() {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const evalRun = useQuery({ queryKey: ["evalRun"], queryFn: api.latestEvalRun });
  const checks = useQuery({ queryKey: ["checks"], queryFn: api.checks });

  const groundTruth = useMutation<GroundTruthRun, Error>({ mutationFn: api.runGroundTruth });

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const run = groundTruth.data;
  const agent = evalRun.data?.run;

  return (
    <div className="space-y-5">
      <p className="text-[12px] leading-relaxed text-ink-300">
        Answers here are only as good as the data behind them and the agent reading it. Both are
        checked, in different ways, and neither claim is asked to be taken on trust.
      </p>

      {/* ---- Tier 1: the data ------------------------------------------ */}
      <section>
        <div className="mb-2 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-[12px] font-semibold text-ink-100">Data checks</h3>
            <p className="text-[11px] text-ink-400">
              Run against the inventory on screen. No model involved, so they are free and instant.
            </p>
          </div>
          <button
            onClick={() => groundTruth.mutate()}
            disabled={groundTruth.isPending}
            className="shrink-0 rounded border border-ink-700 bg-ink-800 px-2.5 py-1 text-[11px] text-ink-100 transition hover:border-ink-600 disabled:opacity-40"
          >
            {groundTruth.isPending ? "Running…" : run ? "Run again" : "Run checks"}
          </button>
        </div>

        {groundTruth.isError && (
          <p className="rounded border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-[11px] text-danger">
            {groundTruth.error.message}
          </p>
        )}

        {!run && !groundTruth.isPending && !groundTruth.isError && (
          <div className="space-y-1">
            <p className="text-[11px] text-ink-400">
              {checks.data?.checks.length ?? 0} checks ready. Each one guards a specific way the
              analysis could be confidently wrong.
            </p>
            <ul className="space-y-0.5">
              {(checks.data?.checks ?? []).slice(0, 4).map((c) => (
                <li key={c.id} className="text-[11px] text-ink-400">
                  · {c.description}
                </li>
              ))}
              {(checks.data?.checks.length ?? 0) > 4 && (
                <li className="text-[11px] text-ink-400">
                  · and {(checks.data?.checks.length ?? 0) - 4} more
                </li>
              )}
            </ul>
          </div>
        )}

        {run && (
          <>
            <div
              className={`mb-2 rounded border px-2.5 py-1.5 text-[12px] ${
                run.passed === run.total
                  ? "border-good/40 bg-good/10 text-good"
                  : run.drifted && run.unexplainedFailures === 0
                    ? // Every failure is accounted for by deliberate drift, so
                      // this is the checks working rather than the analysers
                      // breaking, and it must not read as an alarm.
                      "border-warn/40 bg-warn/10 text-warn"
                    : // A failure nothing explains stays loud, drifted or not.
                      // Previously any drift softened the whole panel, which
                      // meant a genuine regression could hide behind it.
                      "border-danger/40 bg-danger/10 text-danger"
              }`}
            >
              <strong>
                {run.passed}/{run.total} checks passed
              </strong>{" "}
              <span className="opacity-75">
                in {run.durationMs}ms, against the scan from{" "}
                {new Date(run.scannedAt).toLocaleString()}
              </span>
              {run.driftNote && <p className="mt-1 leading-relaxed opacity-90">{run.driftNote}</p>}
            </div>
            <div className="space-y-1">
              {run.results.map((r) => (
                <CheckRow
                  key={r.id}
                  result={r}
                  expanded={expanded.has(r.id)}
                  onToggle={() => toggle(r.id)}
                />
              ))}
            </div>
          </>
        )}
      </section>

      {/* ---- Tier 2: the agent ----------------------------------------- */}
      <section>
        <h3 className="text-[12px] font-semibold text-ink-100">Agent answer quality</h3>
        <p className="mb-2 text-[11px] text-ink-400">
          Scored on the resources each answer cites, against known-correct expectations. These cost
          money to run, so the last recorded run is shown rather than re-run on demand.
        </p>

        {evalRun.isLoading && <div className="h-16 animate-pulse rounded bg-ink-850" />}

        {!evalRun.isLoading && !agent && (
          <p className="rounded border border-ink-800 bg-ink-850 px-2.5 py-2 text-[11px] text-ink-400">
            {evalRun.data?.hint ?? "No agent evals recorded yet."}
          </p>
        )}

        {agent && (
          <>
            <div
              className={`mb-2 rounded border px-2.5 py-1.5 text-[12px] ${
                agent.errored > 0
                  ? "border-ink-600 bg-ink-850 text-ink-300"
                  : agent.passed === agent.graded
                    ? "border-good/40 bg-good/10 text-good"
                    : "border-warn/40 bg-warn/10 text-warn"
              }`}
            >
              {/*
                Out of `graded`, not `total`. A run where four cases never
                reached the model is not a score of 17/21 - it is a score of
                17/17 plus an outage, and conflating them reads as a regression
                that did not happen.
              */}
              <strong>
                {agent.passed}/{agent.graded} cases passed
              </strong>{" "}
              <span className="opacity-75">
                mean F1 {agent.meanF1}
                {agent.unsupportedCitations === 0
                  ? ", no unsupported citations"
                  : `, ${agent.unsupportedCitations} unsupported citations`}
              </span>
              {agent.incompleteNote && (
                <p className="mt-1 rounded border border-warn/40 bg-warn/10 px-1.5 py-1 text-[10px] leading-relaxed text-warn">
                  {agent.incompleteNote}
                </p>
              )}
              <div className="mt-0.5 text-[10px] opacity-70">
                {agent.model} · {new Date(agent.startedAt).toLocaleString()}
                {evalRun.data?.currentModel && evalRun.data.currentModel !== agent.model && (
                  <span className="text-warn">
                    {" "}
                    · currently configured model is {evalRun.data.currentModel}, so these numbers
                    are for a different model
                  </span>
                )}
              </div>
            </div>
            <div className="space-y-0.5">
              {agent.cases.map((c) => (
                <div
                  key={c.id}
                  className="flex items-baseline gap-2 rounded px-1 py-0.5 text-[11px] hover:bg-ink-850"
                >
                  {/* A third state: "did not run" is not a failure. */}
                  <span
                    className={c.errored ? "text-ink-500" : c.passed ? "text-good" : "text-danger"}
                  >
                    {c.errored ? "—" : c.passed ? "✓" : "✗"}
                  </span>
                  <span
                    className={`flex-1 truncate ${c.errored ? "text-ink-500" : "text-ink-300"}`}
                    title={c.errored ? `did not run — ${c.errored}` : c.question}
                  >
                    {c.question}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-ink-400">
                    {c.errored
                      ? "did not run"
                      : `${c.toolsCalled.length} tool${c.toolsCalled.length === 1 ? "" : "s"} · ${(c.durationMs / 1000).toFixed(1)}s`}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      <p className="border-t border-ink-800 pt-3 text-[11px] leading-relaxed text-ink-400">
        What none of this catches: an answer that cites exactly the right resources and describes
        them wrongly. The data checks and the citation validator between them make that unlikely,
        not impossible — which is why every answer shows the tools it used and every verdict shows
        its evidence.
      </p>
    </div>
  );
}

function CheckRow({
  result,
  expanded,
  onToggle,
}: {
  result: CheckResult;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="rounded border border-ink-800 bg-ink-850">
      <button
        onClick={onToggle}
        className="flex w-full items-baseline gap-2 px-2 py-1.5 text-left transition hover:bg-ink-800"
      >
        {/*
          Three states, not two. A check that fails *because* the account was
          deliberately drifted is the check doing its job, and marking it with
          the same red ✗ as an unexplained failure is what made two correct
          detections read as bugs.
        */}
        <span
          className={
            result.passed ? "text-good" : result.expectedAfterDrift ? "text-warn" : "text-danger"
          }
        >
          {result.passed ? "✓" : result.expectedAfterDrift ? "◆" : "✗"}
        </span>
        <span className="flex-1 text-[11px] text-ink-100">{result.description}</span>
        {result.expectedAfterDrift && (
          <span className="shrink-0 rounded border border-warn/40 bg-warn/10 px-1 py-px text-[9px] font-medium text-warn">
            expected after drift
          </span>
        )}
        <span className="shrink-0 text-[10px] text-ink-400">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && (
        <div className="space-y-1 border-t border-ink-800 px-2 py-1.5">
          {result.expectedAfterDrift && (
            <p className="rounded border border-warn/30 bg-warn/5 px-1.5 py-1 text-[10px] leading-snug text-warn">
              <span className="font-medium">Caused by the drift, not a defect: </span>
              {result.expectedAfterDrift}
            </p>
          )}
          <p className="text-[10px] leading-snug text-ink-400">
            <span className="text-ink-300">Why: </span>
            {result.rationale}
          </p>
          <p className="font-mono text-[10px] leading-snug text-ink-400">
            <span className="font-sans text-ink-300">Found: </span>
            {result.detail}
          </p>
        </div>
      )}
    </div>
  );
}
