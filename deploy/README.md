# `deploy/`

Observability for the hosted deployment. The cluster already runs Prometheus,
Grafana and Loki (the sibling project uses them), so nothing here installs
anything — it only connects this service to what is there.

| File                               | What it is                                                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `dashboards/daveio-api.json`       | The Grafana dashboard. Generated, so the panels stay consistent; edit and re-export from Grafana if you prefer clicking. |
| `grafana-dashboard-configmap.yaml` | The same dashboard as a ConfigMap labelled `grafana_dashboard: "1"`, which the Grafana sidecar loads automatically.      |
| `pod-annotations.yaml`             | The three annotations that make Prometheus scrape the API pod, ready to paste into the Deployment when the chart exists. |

```bash
kubectl apply -f deploy/grafana-dashboard-configmap.yaml
```

Until the API is deployed to the cluster the dashboard renders with no data,
which is the honest state rather than a broken one.

## What is instrumented, and why those things

The metric list is short on purpose. Three questions shape it:

**Is it serving?** Request rate, error rate, latency — by route _pattern_
(`/api/resources/:arn`), never by URL. A URL here contains an ARN, which is
customer data and would also mint a new time series per resource.

**Is the product doing its job?** Scans started and finished, duration, AWS API
call rate, queue depth. `partial` is a first-class outcome beside `succeeded`
and `failed`, because a scan that lost a region still returns 200 and looks
perfectly healthy in the request metrics.

**Is anything quietly wrong?** Failed `(service, region)` units by AWS service
and error code; rejected sign-ins by reason; and the one that matters most:

> **`daveio_agent_unsupported_citations_total`** — ARNs an answer cited that no
> tool returned. An answer carrying one is a 200 with a fluent paragraph in it,
> so a regression in grounding is invisible in every other metric. Anything
> above zero is worth opening the conversation.

## What is deliberately not a label

**No tenant id, anywhere.** Prometheus keeps a series per label combination, so
tenant ids would grow the series count without bound and turn a scrape endpoint
into a directory of who the customers are. Per-tenant attribution lives in the
logs, which are queryable and access-controlled.

**No ARNs, no URLs, no error messages.** Error _codes_ (`ThrottlingException`)
are bounded and useful; messages are unbounded and sometimes contain customer
detail.

That discipline is what makes `/metrics` safe to serve without authentication —
which it must be, because Prometheus has no session and cannot be given one.

## Logs

Structured JSON from pino, which Loki ingests as-is. Two deliberate choices:

- **`redact` rather than discipline.** Discipline is a property of whoever
  writes the next log statement. `observability/logging.ts` lists the paths;
  `logging.test.ts` runs pino for real and greps the bytes it produced, because
  checking the list against itself would pass for a path that is spelled wrong
  or nested one level deeper than expected.
- **The request serialiser logs the route pattern, not the URL** — same reason
  as the metric labels. It keeps the tenant id, because that is the one place
  per-tenant attribution belongs.

A useful starting query:

```logql
{app="daveio-api"} | json | level >= 50
```
