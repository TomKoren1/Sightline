/**
 * Deleting the account, from inside the application.
 *
 * A service that holds an inventory of somebody's production estate has to be
 * able to say what leaving looks like, and "email the maintainer" is not that.
 * This is the screen that makes the promise in `PRIVACY.md` into a thing a
 * person can do.
 *
 * Deliberately a little slow to use. The confirmation is the account's own
 * email address, typed - which cannot be clicked through, cannot be done by a
 * cross-site request that does not know it, and makes the dialog impossible to
 * misread. A checkbox gets dismissed; the word DELETE becomes muscle memory.
 *
 * It also says what deletion does *not* do, before the button rather than
 * after: Sightline cannot remove the CloudFormation stacks from the customer's
 * AWS accounts, and somebody who leaves believing their access was withdrawn
 * has been misled about the one thing that matters most here.
 */

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";

import { api } from "../api.js";

export function DeleteAccount({ email, onDeleted }: { email: string; onDeleted: () => void }) {
  const [typed, setTyped] = useState("");

  const remove = useMutation({
    mutationFn: () => api.deleteAccount(typed),
    onSuccess: onDeleted,
  });

  // Compared the way the server compares it, so the button is not enabled for
  // something the server will then refuse.
  const matches = typed.trim().toLowerCase() === email.trim().toLowerCase();

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12px] leading-relaxed text-ink-300">
        This deletes your account and everything Sightline holds about it: every connected account,
        every scan and its resource history, your graph, and every conversation with the assistant.
        It is immediate and cannot be undone. If other people are in this workspace, it deletes only
        you: you leave, and the workspace and its data stay with them. Its last owner has to make
        someone else an owner first.
      </p>

      <div className="rounded border border-warn/40 bg-warn/10 px-2.5 py-2 text-[11px] leading-relaxed text-warn">
        Sightline <span className="font-semibold">cannot</span> delete the CloudFormation stacks in
        your AWS accounts — only you can. Until you do, the roles they created still exist. Your
        ExternalIds are deleted here, so the roles cannot be assumed, but the right thing is to
        delete the stacks too.
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
            Type <span className="font-mono text-ink-100">{email}</span> to confirm
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
          {remove.isPending ? "Deleting…" : "Delete everything"}
        </button>

        {remove.isError && <p className="text-[11px] text-danger">{remove.error.message}</p>}
      </form>

      <p className="text-[11px] leading-relaxed text-ink-400">
        An encrypted nightly backup may still contain your data for up to 30 days, after which it
        rotates out. Saying otherwise would mean either having no backups or being wrong about them
        — see the{" "}
        <a href="/privacy" className="text-accent underline">
          privacy policy
        </a>
        .
      </p>
    </div>
  );
}
