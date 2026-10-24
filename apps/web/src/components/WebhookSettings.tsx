/** Where new exposed and admin findings are posted: a Slack-style incoming webhook. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { api } from "../api.js";

export function WebhookSettings() {
  const queryClient = useQueryClient();
  const webhook = useQuery({ queryKey: ["webhook"], queryFn: api.webhook });
  const [url, setUrl] = useState("");
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["webhook"] });
  const save = useMutation({
    mutationFn: () => api.setWebhook(url.trim()),
    onSuccess: () => {
      setUrl("");
      refresh();
    },
  });
  const remove = useMutation({ mutationFn: api.removeWebhook, onSuccess: refresh });
  const test = useMutation({ mutationFn: api.testWebhook, onSuccess: refresh });
  const failure = save.error ?? remove.error ?? test.error;
  const current = webhook.data;

  return (
    <section>
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-400">
        Alerts
      </h3>
      <p className="mb-2 text-[11px] text-ink-400">
        New exposed and admin findings are posted to this webhook after each scan. Slack, Teams
        workflows and Mattermost incoming webhooks all work.
      </p>
      {current?.configured ? (
        <div className="flex items-center gap-2 text-[11px] text-ink-400">
          <span className="min-w-0 flex-1 truncate">
            <span className="text-ink-100">{current.host}</span>
            {current.lastDeliveryAt
              ? ` · last sent ${new Date(current.lastDeliveryAt).toLocaleString()}: ${current.lastStatus ?? ""}`
              : " · nothing sent yet"}
          </span>
          <button
            onClick={() => test.mutate()}
            disabled={test.isPending}
            className="rounded border border-ink-700 px-2 py-0.5 text-ink-400 hover:text-ink-100"
          >
            Send a test
          </button>
          <button
            onClick={() => remove.mutate()}
            disabled={remove.isPending}
            className="rounded border border-ink-700 px-2 py-0.5 text-ink-400 hover:text-danger"
          >
            Remove
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <input
            aria-label="Webhook URL"
            placeholder="https://hooks.slack.com/services/…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="min-w-0 flex-1 rounded border border-ink-700 bg-ink-900 px-2 py-1 font-mono text-[11px] text-ink-100"
          />
          <button
            onClick={() => save.mutate()}
            disabled={save.isPending || !url.trim().startsWith("https://")}
            className="rounded bg-accent px-3 py-1.5 text-[12px] font-medium text-ink-950 transition disabled:opacity-40"
          >
            Save
          </button>
        </div>
      )}
      {test.data && (
        <p className={`mt-2 text-[11px] ${test.data.ok ? "text-good" : "text-danger"}`}>
          Test {test.data.ok ? "delivered" : "failed"}: {test.data.status}
        </p>
      )}
      {failure && <p className="mt-2 text-[11px] text-danger">{failure.message}</p>}
    </section>
  );
}
