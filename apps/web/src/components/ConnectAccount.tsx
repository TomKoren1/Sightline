/**
 * Connecting an AWS account: name it, click one link, type twelve digits.
 *
 * The flow is built around what actually loses people. A pasted role ARN is the
 * step they mistype, so the ARN is derived and only the account id is asked for.
 * Coming back to press a button is the step they forget, so the screen polls
 * and goes green on its own while they are still looking at CloudFormation. And
 * a stack that fails to deploy must be recoverable, so the ExternalId stays
 * readable rather than being shown once and lost.
 *
 * Two alternatives sit behind the link, because a quick-create link is useless
 * to anyone whose organisation forbids creating stacks from the console, and
 * telling them to do it anyway is how onboarding stops at the first screen.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";

import { api, type VerifyResult } from "../api.js";
import { Copyable } from "./Copyable.js";

/** Slow enough to be polite to STS, fast enough to feel immediate. */
const POLL_MS = 4000;

type Alternative = "console" | "cli" | "terraform";

export function ConnectAccount({ onConnected }: { onConnected: (id: string) => void }) {
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<"real" | "organization">("real");
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [accountId, setAccountId] = useState("");
  const [alternative, setAlternative] = useState<Alternative>("console");
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [polling, setPolling] = useState(false);

  const create = useMutation({
    mutationFn: () => api.createConnection({ label: label.trim(), kind }),
    onSuccess: (created) => setConnectionId(created.id),
  });

  const plan = useQuery({
    queryKey: ["onboarding", connectionId],
    queryFn: () => api.connectionOnboarding(connectionId!),
    enabled: Boolean(connectionId),
    // The ExternalId must not change while somebody is copying it.
    staleTime: Infinity,
  });

  const target = useMutation({
    mutationFn: () => api.setConnectionTarget(connectionId!, accountId),
    onSuccess: () => setPolling(true),
  });

  /**
   * Poll until the role can be assumed.
   *
   * In an effect with a ref rather than an interval over a mutation, so that a
   * slow attempt cannot overlap the next one - two concurrent AssumeRoles
   * against the same connection would trip the server's own floor and report a
   * rate limit as a connection failure.
   */
  const inFlight = useRef(false);
  const attempt = useCallback(async () => {
    if (!connectionId || inFlight.current) return;
    inFlight.current = true;
    try {
      const verified = await api.verifyConnection(connectionId);
      setResult(verified);
      if (verified.ok) {
        setPolling(false);
        // An organization holds no inventory of its own: show one of its
        // accounts, the first that connected.
        const member = verified.organization?.members.find((m) => m.ok)?.connectionId;
        if (!verified.organization || member) onConnected(member ?? connectionId);
      }
    } catch {
      // A transport failure is not a connection failure; the next tick retries.
    } finally {
      inFlight.current = false;
    }
  }, [connectionId, onConnected]);

  useEffect(() => {
    if (!polling) return;
    void attempt();
    const timer = setInterval(() => void attempt(), POLL_MS);
    return () => clearInterval(timer);
  }, [polling, attempt]);

  // --- step 1: name it ------------------------------------------------------
  if (!connectionId) {
    return (
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (label.trim()) create.mutate();
        }}
      >
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-[12px] text-ink-300">What are you connecting?</legend>
          {(
            [
              ["real", "One AWS account"],
              ["organization", "An AWS Organization: every account in it"],
            ] as const
          ).map(([value, text]) => (
            <label key={value} className="flex items-center gap-2 text-[12px] text-ink-100">
              <input
                type="radio"
                name="kind"
                checked={kind === value}
                onChange={() => setKind(value)}
                className="accent-accent"
              />
              {text}
            </label>
          ))}
        </fieldset>
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] text-ink-300">
            What should this {kind === "organization" ? "organization" : "account"} be called?
          </span>
          <input
            autoFocus
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Production"
            maxLength={60}
            className="rounded border border-ink-700 bg-ink-900 px-2.5 py-1.5 text-[12px] text-ink-100 outline-none focus:border-accent"
          />
          <span className="text-[11px] text-ink-400">
            Just a name you will recognise. You can connect more than one.
          </span>
        </label>
        <button
          type="submit"
          disabled={!label.trim() || create.isPending}
          className="self-start rounded bg-accent px-3 py-1.5 text-[12px] font-medium text-ink-950 transition disabled:cursor-not-allowed disabled:opacity-40"
        >
          {create.isPending ? "Creating…" : "Continue"}
        </button>
        {create.isError && <p className="text-[11px] text-danger">{create.error.message}</p>}
      </form>
    );
  }

  if (plan.isLoading) return <div className="h-40 animate-pulse rounded bg-ink-850" />;
  if (plan.error) {
    return <p className="text-[12px] text-danger">{plan.error.message}</p>;
  }
  if (!plan.data) return null;

  // --- step 4: done --------------------------------------------------------
  if (result?.ok && result.organization) {
    const org = result.organization;
    return (
      <div className="flex flex-col gap-3">
        <p className="text-[13px] text-good">
          Connected to the organization: {org.found} active accounts found.
        </p>
        <ul className="flex flex-col gap-1 text-[11px]">
          {org.members.map((m) => (
            <li key={m.connectionId} className={m.ok ? "text-ink-300" : "text-warn"}>
              {m.ok ? "✓" : "…"} {m.label}
              {m.problem ? ` — ${m.problem}` : ""}
            </li>
          ))}
        </ul>
        {org.unchecked > 0 && (
          <p className="text-[11px] text-ink-400">
            {org.unchecked} more are still to be checked; press the check again, or scan them, and
            each is checked first.
          </p>
        )}
        {org.alreadyConnected.length > 0 && (
          <p className="text-[11px] text-ink-400">
            Already connected on their own, so left as they are: {org.alreadyConnected.join(", ")}.
          </p>
        )}
        <p className="text-[11px] text-ink-400">
          Each account is now its own entry under the organization in the account menu. Accounts
          that join later are found the next time the organization is checked.
        </p>
      </div>
    );
  }

  if (result?.ok) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-[13px] text-good">Connected to account {result.accountId}.</p>
        <p className="text-[12px] leading-relaxed text-ink-300">
          Sightline assumed the role and confirmed which account it reached. That account id is now
          pinned: if the role is ever repointed somewhere else, the next scan refuses rather than
          filing one account&apos;s inventory under another&apos;s name.
        </p>
        <p className="text-[11px] text-ink-400">
          Nothing has been scanned yet. Close this and press <em>Run scan</em>.
        </p>
      </div>
    );
  }

  // --- steps 2 and 3: deploy, then tell us the account id ------------------
  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-1 border-b border-ink-800 text-[11px]">
        {(
          [
            ["console", "One click"],
            ["cli", "AWS CLI"],
            ["terraform", "Terraform"],
          ] as const
        ).map(([key, title]) => (
          <button
            key={key}
            onClick={() => setAlternative(key)}
            className={`-mb-px border-b px-2 py-1.5 transition ${
              alternative === key
                ? "border-accent text-ink-100"
                : "border-transparent text-ink-400 hover:text-ink-100"
            }`}
          >
            {title}
          </button>
        ))}
      </div>

      {alternative === "console" && (
        <div className="flex flex-col gap-2">
          <a
            href={plan.data.launchUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="self-start rounded bg-accent px-3 py-1.5 text-[12px] font-medium text-ink-950 transition hover:brightness-110"
          >
            Launch stack in AWS →
          </a>
          <p className="text-[11px] leading-relaxed text-ink-400">
            Opens CloudFormation with everything filled in. Tick the box acknowledging that it
            creates an IAM role — that role is the whole point — and press{" "}
            <span className="text-ink-100">Create stack</span>. Leave the tab open; this screen
            notices on its own.
          </p>
        </div>
      )}

      {alternative === "cli" && (
        <div className="flex flex-col gap-1.5">
          <p className="text-[11px] text-ink-400">
            Runs anywhere the AWS CLI is configured, including CloudShell.
          </p>
          <Copyable value={plan.data.cliCommand} />
        </div>
      )}

      {alternative === "terraform" && (
        <div className="flex flex-col gap-1.5">
          <p className="text-[11px] text-ink-400">The same stack, for an estate managed as code.</p>
          <Copyable value={plan.data.terraform} />
        </div>
      )}

      {plan.data.stackSet && (
        <div className="flex flex-col gap-1.5 rounded border border-ink-800 p-2.5">
          <p className="text-[12px] text-ink-100">Every member account</p>
          <p className="text-[11px] leading-relaxed text-ink-400">
            Run this from the management account: a StackSet that puts the same role, with the same
            ExternalId, in every account now and every account added later. It skips the management
            account itself, which gets the stack above. Then enter the management account&apos;s id
            below.
          </p>
          <Copyable value={plan.data.stackSet} />
        </div>
      )}

      <details className="text-[11px] text-ink-400">
        <summary className="cursor-pointer text-ink-300">
          What this grants, and the ExternalId
        </summary>
        <div className="mt-2 flex flex-col gap-2 border-l border-ink-800 pl-3">
          <p className="leading-relaxed">
            The role lets Sightline read configuration and metadata. It carries an explicit Deny on
            object, record, parameter and secret contents, and a Deny cannot be overridden by any
            Allow — including one a future AWS update might add to a managed policy.
          </p>
          <p className="leading-relaxed">
            The <span className="text-ink-100">ExternalId</span> below is a secret shared between
            Sightline and this account. It is what stops anyone else persuading Sightline to assume
            a role on their behalf: knowing the role ARN is not enough.
          </p>
          <Copyable value={plan.data.externalId} />
          <p className="leading-relaxed">
            Trusted principal: <code className="break-all">{plan.data.scannerPrincipalArn}</code>
          </p>
        </div>
      </details>

      <form
        className="flex flex-col gap-2 border-t border-ink-800 pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (/^\d{12}$/.test(accountId)) target.mutate();
        }}
      >
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] text-ink-300">Your 12-digit AWS account ID</span>
          <input
            value={accountId}
            onChange={(e) => setAccountId(e.target.value.replace(/\D/g, "").slice(0, 12))}
            placeholder="123456789012"
            inputMode="numeric"
            className="w-48 rounded border border-ink-700 bg-ink-900 px-2.5 py-1.5 font-mono text-[12px] text-ink-100 outline-none focus:border-accent"
          />
          <span className="text-[11px] text-ink-400">
            That is all Sightline needs — the role&apos;s name is fixed by the template, so the ARN
            is derived: <code>{plan.data.roleArnPattern}</code>
          </span>
        </label>

        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={!/^\d{12}$/.test(accountId) || target.isPending || polling}
            className="rounded border border-ink-700 bg-ink-800 px-3 py-1.5 text-[12px] text-ink-100 transition hover:border-ink-600 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {polling ? "Waiting for the role…" : target.isPending ? "Saving…" : "Check connection"}
          </button>
          {polling && <span className="pulse h-1.5 w-1.5 rounded-full bg-accent" />}
        </div>

        {target.isError && <p className="text-[11px] text-danger">{target.error.message}</p>}

        {/*
          A failure while polling is expected at first: the stack takes a moment
          to create the role. The diagnosis is shown anyway, because once it
          stops being "no such role" it is the thing that tells them what to fix.
        */}
        {result && !result.ok && (
          <div className="flex flex-col gap-1 rounded border border-warn/40 bg-warn/10 px-2.5 py-2">
            <p className="text-[11px] text-warn">
              {result.problem ?? result.diagnosis?.problem ?? "Not connected yet."}
            </p>
            {result.diagnosis?.fix && (
              <p className="whitespace-pre-wrap text-[11px] leading-relaxed text-ink-300">
                {result.diagnosis.fix}
              </p>
            )}
          </div>
        )}
      </form>
    </div>
  );
}
