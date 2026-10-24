/**
 * Who is in this workspace, and inviting more.
 *
 * An invite is a link to copy and send however you like: Sightline sends no
 * email. It is shown once, works once, and lasts a week. Roles are explained
 * where they are chosen, because "member" means nothing until it is spelled
 * out next to the alternatives.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { api, can, type TeamRole } from "../api.js";
import { AuditLog } from "./AuditLog.js";
import { Copyable } from "./Copyable.js";

const ROLE_HELP: Record<TeamRole, string> = {
  viewer: "reads everything and asks questions",
  member: "also runs scans and accepts findings",
  admin: "also connects accounts and manages the team",
  owner: "also deletes the workspace and makes owners",
};

/** The same, said to the person who holds the role. */
const YOU_CAN: Record<TeamRole, string> = {
  viewer: "can read everything and ask questions",
  member: "can read, ask, run scans and accept findings",
  admin: "can do what a member can, and connect accounts and manage the team",
  owner: "can do everything, including deleting the workspace and making owners",
};

const INVITABLE: TeamRole[] = ["viewer", "member", "admin"];

export function Team() {
  const queryClient = useQueryClient();
  const team = useQuery({ queryKey: ["team"], queryFn: api.team });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["team"] });

  const [inviteRole, setInviteRole] = useState<TeamRole>("member");
  const [link, setLink] = useState<string | null>(null);
  const invite = useMutation({
    mutationFn: () => api.createInvite(inviteRole),
    onSuccess: (created) => {
      setLink(created.url);
      refresh();
    },
  });
  const revoke = useMutation({ mutationFn: api.revokeInvite, onSuccess: refresh });
  const setRole = useMutation({
    mutationFn: ({ id, role }: { id: string; role: TeamRole }) => api.setMemberRole(id, role),
    onSuccess: refresh,
  });
  const remove = useMutation({ mutationFn: api.removeMember, onSuccess: refresh });
  const failure = [invite, revoke, setRole, remove].find((m) => m.isError)?.error;

  if (team.isLoading) return <div className="h-40 animate-pulse rounded bg-ink-850" />;
  if (team.error) return <p className="text-[12px] text-danger">{team.error.message}</p>;
  if (!team.data) return null;

  const { you, members, invites } = team.data;
  const manage = can(you.role, "admin");
  const roleChoices = (target: TeamRole): TeamRole[] =>
    you.role === "owner"
      ? ["viewer", "member", "admin", "owner"]
      : target === "owner"
        ? []
        : INVITABLE;

  return (
    <div className="flex flex-col gap-5 text-[12px]">
      <section>
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-400">
          Members
        </h3>
        <ul className="flex flex-col divide-y divide-ink-800 rounded border border-ink-800">
          {members.map((m) => (
            <li key={m.id} className="flex items-center gap-2 px-2.5 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-ink-100">
                  {m.name ?? m.email}
                  {m.id === you.id && <span className="ml-1.5 text-[10px] text-ink-400">you</span>}
                </p>
                {m.name && <p className="truncate text-[11px] text-ink-400">{m.email}</p>}
              </div>
              {manage && m.id !== you.id && roleChoices(m.role).length > 0 ? (
                <select
                  aria-label={`Role of ${m.email}`}
                  value={m.role}
                  disabled={setRole.isPending}
                  onChange={(e) => setRole.mutate({ id: m.id, role: e.target.value as TeamRole })}
                  className="rounded border border-ink-700 bg-ink-900 px-1.5 py-1 text-[11px] text-ink-100"
                >
                  {roleChoices(m.role).map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="text-[11px] text-ink-300">{m.role}</span>
              )}
              {manage && m.id !== you.id && (m.role !== "owner" || you.role === "owner") && (
                <button
                  onClick={() => remove.mutate(m.id)}
                  disabled={remove.isPending}
                  className="rounded border border-ink-700 px-2 py-1 text-[11px] text-ink-400 transition hover:border-danger/60 hover:text-danger"
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      {manage && (
        <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-400">
            Invite someone
          </h3>
          <div className="flex items-center gap-2">
            <select
              aria-label="Role for the invite"
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as TeamRole)}
              className="rounded border border-ink-700 bg-ink-900 px-1.5 py-1 text-[11px] text-ink-100"
            >
              {INVITABLE.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <span className="flex-1 text-[11px] text-ink-400">{ROLE_HELP[inviteRole]}</span>
            <button
              onClick={() => invite.mutate()}
              disabled={invite.isPending}
              className="rounded bg-accent px-3 py-1.5 text-[12px] font-medium text-ink-950 transition disabled:opacity-40"
            >
              Create link
            </button>
          </div>
          {link && (
            <div className="mt-3">
              <Copyable
                value={link}
                label="Send this to them. It is shown once and works once, for a week."
              />
            </div>
          )}
          {invites.length > 0 && (
            <ul className="mt-3 flex flex-col gap-1">
              {invites.map((i) => (
                <li key={i.id} className="flex items-center gap-2 text-[11px] text-ink-400">
                  <span className="flex-1">
                    Open invite as {i.role}, until {new Date(i.expiresAt).toLocaleDateString()}
                    {i.createdBy ? `, from ${i.createdBy}` : ""}
                  </span>
                  <button
                    onClick={() => revoke.mutate(i.id)}
                    className="rounded border border-ink-700 px-2 py-0.5 text-ink-400 hover:text-ink-100"
                  >
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {manage && <AuditLog />}

      {failure && <p className="text-[11px] text-danger">{failure.message}</p>}

      <p className="border-t border-ink-800 pt-3 text-[11px] leading-relaxed text-ink-400">
        You are {you.role === "admin" || you.role === "owner" ? "an" : "a"} {you.role}, so you{" "}
        {YOU_CAN[you.role]}.
      </p>
    </div>
  );
}
