/**
 * Switch between the seeded demo account and the configured real one.
 *
 * Runtime only - `.env` is not rewritten, so a restart returns to whatever it
 * says. A toggle that silently edits configuration is a nasty surprise, and
 * being able to get back to a known state by restarting is worth more than
 * persisting the choice.
 *
 * Switching does not rescan. The graph keeps showing the previous account's
 * inventory until one runs, and the UI says so rather than letting someone read
 * one account's resources under the other's name.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../api.js";

export function ModeToggle({ onSwitched }: { onSwitched: (note: string) => void }) {
  const queryClient = useQueryClient();
  const connection = useQuery({ queryKey: ["connection"], queryFn: api.connection });

  const switchMode = useMutation({
    mutationFn: api.setMode,
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["connection"] });
      onSwitched(result.note ?? "Switched account.");
    },
  });

  const c = connection.data;
  if (!c) return null;

  /**
   * Hosted and self-hosted mean different things by the left-hand option.
   *
   * Self-hosted: "mock", a process-wide switch the operator owns. Hosted:
   * "demo", a column on the tenant, so one person switching changes only
   * their own view (ADR-020). The labels are the same because the user's
   * question is the same - am I looking at the demo, or at my account?
   */
  const hosted = c.mode === "demo" || c.mode === "real" ? c.demoAvailable !== undefined : false;
  const demoValue = hosted ? "demo" : "mock";
  const onDemo = c.mode === demoValue;
  const canSwitchToReal = c.realAccountConfigured && !c.roleArnProblem;
  const canSwitchToDemo = c.demoAvailable !== false;

  /**
   * Why "My AWS" cannot be selected, in words, next to the button.
   *
   * It used to be disabled with the explanation only in a `title` tooltip, and
   * a disabled control that gives no visible reason reads as a broken one -
   * which is exactly how it was reported. The common cause is also not what
   * the tooltip said: configuration is read once at startup, so editing `.env`
   * without restarting the API leaves the process reporting the old values and
   * the button correctly, but confusingly, disabled. See engineering log #28.
   */
  const blockedReason = c.roleArnProblem
    ? "AWS_TARGET_ROLE_ARN cannot be assumed — open Connect for the fix"
    : c.realAccountConfigured
      ? null
      : hosted
        ? "no AWS account connected yet — open Connection to add one"
        : "no real account in .env — set AWS_TARGET_ROLE_ARN, then restart the API";

  return (
    <div className="flex items-center gap-1.5">
      <div className="flex overflow-hidden rounded border border-ink-700">
        {([demoValue, "real"] as const).map((mode) => {
          const active = c.mode === mode;
          const disabled =
            switchMode.isPending ||
            (mode === "real" && !canSwitchToReal) ||
            (mode !== "real" && !canSwitchToDemo);
          return (
            <button
              key={mode}
              onClick={() => !active && switchMode.mutate(mode)}
              disabled={disabled || active}
              title={
                mode === "real" && blockedReason
                  ? `${blockedReason}. Configuration is read once at startup, so an edit to .env with no restart changes nothing.`
                  : mode !== "real"
                    ? canSwitchToDemo
                      ? "The seeded demo account — explore without connecting anything"
                      : "This deployment has no demo account configured"
                    : `Your AWS account ${c.accountId ?? ""}`
              }
              className={`px-2 py-1 text-[11px] transition ${
                active
                  ? mode === "real"
                    ? "bg-accent text-ink-950"
                    : "bg-ink-700 text-ink-100"
                  : "bg-ink-850 text-ink-400 hover:text-ink-100 disabled:cursor-not-allowed disabled:opacity-40"
              }`}
            >
              {mode === "real" ? "My AWS" : "Demo"}
            </button>
          );
        })}
      </div>
      {switchMode.isPending && <span className="pulse h-1.5 w-1.5 rounded-full bg-accent" />}
      {/* The toggle diverging from .env is worth showing: it explains why a
          restart would change what you are looking at. */}
      {/* Only meaningful for the process-wide switch; a hosted tenant's
          choice is their own and persists, so there is nothing to diverge
          from. */}
      {!hosted && !switchMode.isPending && c.mode !== c.configuredMode && (
        <span
          className="text-[10px] text-warn"
          title={`.env says ${c.configuredMode}; a restart will return to it`}
        >
          overridden
        </span>
      )}
      {switchMode.isError && (
        <span className="text-[10px] text-danger" title={(switchMode.error as Error).message}>
          failed
        </span>
      )}
      {/* The reason the button is dead, visible rather than hidden in a tooltip. */}
      {blockedReason && !switchMode.isPending && (
        <span className="max-w-[22rem] truncate text-[10px] text-warn" title={blockedReason}>
          {blockedReason}
        </span>
      )}
      <span className="text-[10px] text-ink-400" title={c.roleArn}>
        {onDemo ? "demo account" : (c.accountId ?? "not connected")}
      </span>
    </div>
  );
}
