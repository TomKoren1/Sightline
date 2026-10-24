/**
 * Removing one AWS account from this tenant.
 *
 * The counterpart to connecting, and it has to exist in the product. The route
 * and the purge behind it were written in the same phase as the rest of
 * onboarding, and until now the only way to reach either was devtools — which
 * is not an answer for a service that holds an inventory of somebody's estate.
 *
 * Confirmed by typing the label, for the reason `DeleteAccount` asks for the
 * email: this is not recoverable by clicking back. The scans, the resource
 * history, the graph and the conversations for that account all go with it.
 *
 * And it says the part nobody expects: re-connecting the same AWS account
 * later issues a **new** ExternalId, so the CloudFormation stack has to be
 * redeployed before it will verify again. Learning that after the fact, with
 * the account already gone, is how a safe-looking button becomes an afternoon.
 */

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";

import { api, type ConnectionSummary } from "../api.js";

export function DisconnectAccount({
  connection,
  onDisconnected,
}: {
  connection: ConnectionSummary;
  onDisconnected: () => void;
}) {
  const [typed, setTyped] = useState("");

  const remove = useMutation({
    mutationFn: () => api.disconnect(connection.id),
    onSuccess: onDisconnected,
  });

  // Compared the way the server compares a confirmation, so the button is
  // never enabled for something that will then be refused.
  const matches = typed.trim().toLowerCase() === connection.label.trim().toLowerCase();

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12px] leading-relaxed text-ink-300">
        This removes{" "}
        <span className="font-mono text-ink-100">{connection.accountId ?? connection.label}</span>{" "}
        from Sightline: every scan of it, its resource history, its graph, and every conversation
        about it. It is immediate and cannot be undone.
        {connection.kind === "organization" &&
          " Removing an organization removes every account it found, with all of theirs."}
      </p>

      <div className="rounded border border-warn/40 bg-warn/10 px-2.5 py-2 text-[11px] leading-relaxed text-warn">
        Connecting this account again later issues a <span className="font-semibold">new</span>{" "}
        ExternalId, so you would need to redeploy its CloudFormation stack before it verifies.
        Sightline <span className="font-semibold">cannot</span> delete that stack — only you can,
        and until you do, the role it created still exists.
      </div>

      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (matches) remove.mutate();
        }}
      >
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] text-ink-300">
            Type <span className="font-mono text-ink-100">{connection.label}</span> to confirm
          </span>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="rounded border border-ink-700 bg-ink-900 px-2.5 py-1.5 font-mono text-[12px] text-ink-100 outline-none focus:border-danger"
          />
        </label>

        <button
          type="submit"
          disabled={!matches || remove.isPending}
          className="self-start rounded bg-danger px-3 py-1.5 text-[12px] font-medium text-ink-950 transition disabled:cursor-not-allowed disabled:opacity-40"
        >
          {remove.isPending ? "Disconnecting…" : "Disconnect this account"}
        </button>

        {remove.isError && <p className="text-[11px] text-danger">{remove.error.message}</p>}
      </form>
    </div>
  );
}
