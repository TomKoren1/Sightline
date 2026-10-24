/** API tokens for scripts and CI: made here, shown once, revoked here. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { api, type TeamRole } from "../api.js";
import { Copyable } from "./Copyable.js";

const ROLES: TeamRole[] = ["viewer", "member", "admin"];
const LIFETIMES = [30, 90, 365];

export function ApiTokens({ yourRole }: { yourRole: TeamRole }) {
  const queryClient = useQueryClient();
  const tokens = useQuery({ queryKey: ["apiTokens"], queryFn: api.apiTokens });
  const [name, setName] = useState("");
  const [role, setRole] = useState<TeamRole>("viewer");
  const [days, setDays] = useState(90);
  const [shown, setShown] = useState<string | null>(null);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["apiTokens"] });

  const create = useMutation({
    mutationFn: () => api.createApiToken({ name: name.trim(), role, expiresInDays: days }),
    onSuccess: (made) => {
      setShown(made.token);
      setName("");
      refresh();
    },
  });
  const revoke = useMutation({ mutationFn: api.revokeApiToken, onSuccess: refresh });
  const choices = yourRole === "owner" ? ROLES : ROLES.slice(0, ROLES.indexOf(yourRole) + 1);
  const failure = create.error ?? revoke.error;

  return (
    <section>
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-400">
        API tokens
      </h3>
      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label="Token name"
          placeholder="What it is for, e.g. CI"
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          className="min-w-0 flex-1 rounded border border-ink-700 bg-ink-900 px-2 py-1 text-[11px] text-ink-100"
        />
        <select
          aria-label="Token role"
          value={role}
          onChange={(e) => setRole(e.target.value as TeamRole)}
          className="rounded border border-ink-700 bg-ink-900 px-1.5 py-1 text-[11px] text-ink-100"
        >
          {choices.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <select
          aria-label="Token lifetime"
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          className="rounded border border-ink-700 bg-ink-900 px-1.5 py-1 text-[11px] text-ink-100"
        >
          {LIFETIMES.map((d) => (
            <option key={d} value={d}>
              {d} days
            </option>
          ))}
        </select>
        <button
          onClick={() => create.mutate()}
          disabled={create.isPending || name.trim() === ""}
          className="rounded bg-accent px-3 py-1.5 text-[12px] font-medium text-ink-950 transition disabled:opacity-40"
        >
          Create token
        </button>
      </div>
      {shown && (
        <div className="mt-3">
          <Copyable
            value={shown}
            label="Shown once. Send it as `Authorization: Bearer <token>`. It cannot manage tokens, the team or the account."
          />
        </div>
      )}
      {tokens.data && tokens.data.tokens.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1">
          {tokens.data.tokens.map((t) => (
            <li key={t.id} className="flex items-center gap-2 text-[11px] text-ink-400">
              <span className="min-w-0 flex-1 truncate">
                <span className="text-ink-100">{t.name}</span> · {t.role} · from {t.createdBy}
                {" · "}
                {t.lastUsedAt
                  ? `used ${new Date(t.lastUsedAt).toLocaleDateString()}`
                  : "never used"}
                {t.expiresAt ? ` · until ${new Date(t.expiresAt).toLocaleDateString()}` : ""}
              </span>
              <button
                onClick={() => revoke.mutate(t.id)}
                disabled={revoke.isPending}
                className="rounded border border-ink-700 px-2 py-0.5 text-ink-400 hover:text-danger"
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
      {failure && <p className="mt-2 text-[11px] text-danger">{failure.message}</p>}
    </section>
  );
}
