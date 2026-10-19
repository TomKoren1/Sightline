# The monitoring stack

Prometheus, Grafana, Loki and Alertmanager for **every** application on this
cluster, not for one of them. Three pinned upstream charts plus this
repository's dashboards and alert rules.

```bash
helm dependency build helm/monitoring            # deps are committed, so rarely needed
helm template monitoring helm/monitoring -n monitoring   # render
kubectl apply -f argocd/monitoring-application.yaml      # let ArgoCD own it
```

## There are two copies of this chart, and only one may run

An identical chart lives in `resume_builder/helm/monitoring`. **This one is
canonical.** The other exists so that repository can stand the platform up if
this one is unavailable, and it is not deployed — there is no ArgoCD
Application pointing at it.

That arrangement has exactly one failure mode: both get deployed, each ends up
with half the data, and together they want 2.4 GB on a node with about one
spare. So it is checked rather than remembered —
`MonitoringStackDuplicated` fires on `count(up{job="prometheus"}) > 1`.

To switch which copy is active: delete one ArgoCD Application, wait for the
pods to go, then create the other. Never both at once.

`infra/monitoringChart.test.ts` compares the two `Chart.yaml` files when the
other repository is checked out, because the inactive copy is code nobody runs
and identical pins are the only thing keeping it runnable.

## Before the first sync: two secrets

Both sealed to this cluster's controller key, so they are safe in a public
repository and useless anywhere else.

```bash
# 1. Grafana's admin login.
kubectl -n monitoring create secret generic monitoring-grafana-admin \
  --dry-run=client -o yaml \
  --from-literal=admin-user=admin \
  --from-literal=admin-password="$(openssl rand -base64 24)" \
  | kubeseal --format yaml > templates/grafana-admin-sealedsecret.yaml

# 2. The Slack webhooks — two channels, one per project.
kubectl -n monitoring create secret generic monitoring-slack \
  --dry-run=client -o yaml \
  --from-literal=SLACK_WEBHOOK='https://hooks.slack.com/services/...' \
  --from-literal=SIGHTLINE_SLACK_WEBHOOK='https://hooks.slack.com/services/...' \
  | kubeseal --format yaml > templates/slack-sealedsecret.yaml
```

Then set `prometheus.alertmanager.enabled: true` in `values.yaml`.

**It ships disabled on purpose.** With Alertmanager on and that secret missing,
its pod waits in `ContainerCreating` for ever and the first sync looks broken —
which is how the Sightline backup CronJob hid for thirty hours. Prometheus
still evaluates every rule and Grafana still shows them; only Slack delivery
waits.

## The cutover from the old stack

The stack currently runs as three subcharts of the `resume-builder` release, in
that namespace. Measured before writing this: **~1 GB free and the stack needs
~1.2 GB**, so the two cannot overlap. A hard cutover, in this order:

```bash
# 1. Make room. Nobody but you is using Sightline.
kubectl -n sightline scale deploy/api deploy/worker deploy/web --replicas=0

# 2. Stop the old stack, keeping its data. --cascade=orphan leaves the pods
#    and PVCs behind for ArgoCD to stop managing rather than deleting them.
kubectl -n argocd delete application resume-builder --cascade=orphan
#    Then remove the three dependencies from that chart and push, so a later
#    sync does not bring them back.

# 3. Delete the orphaned workloads, but not the PVCs.
kubectl -n resume-builder delete deploy,statefulset,daemonset \
  -l 'app.kubernetes.io/name in (prometheus,grafana,loki,promtail)'

# 4. Bring up the new one.
kubectl apply -f argocd/monitoring-application.yaml
kubectl -n argocd patch application monitoring --type merge \
  -p '{"operation":{"sync":{}}}'

# 5. Put Sightline back.
kubectl -n sightline scale deploy/api deploy/web --replicas=2
kubectl -n sightline scale deploy/worker --replicas=1
```

**15 days of Prometheus history and the existing Loki logs stay in the old
PVCs.** At 15-day retention neither is precious, and keeping the volumes means
the decision to discard them is yours and reversible for a while:

```bash
kubectl -n resume-builder get pvc        # when you are happy
kubectl -n resume-builder delete pvc resume-builder-prometheus-server storage-resume-builder-loki-0
```

## After the cutover, check these four

```bash
# Sightline's targets are up - the NetworkPolicy allows the monitoring
# namespace to reach 9464, and nothing else to.
kubectl -n monitoring port-forward svc/monitoring-prometheus-server 9090:80
#   then: http://localhost:9090/targets  → api and worker both UP

# Dashboards arrived from another namespace, which needs searchNamespace: ALL.
kubectl -n monitoring logs deploy/monitoring-grafana -c grafana-sc-dashboard | tail

# Logs are still flowing after promtail moved namespace.
#   In Grafana: {namespace="sightline"} | json | level >= 50

# Nothing is duplicated.
#   In Prometheus: count(up{job="prometheus"})   → 1
```

## Two things that are deliberate rather than overlooked

**Alert rules for both projects live in this chart.** The plain `prometheus`
chart has no rule-discovery sidecar — rules come from `serverFiles` or not at
all. The resume-builder groups are carried here verbatim, comments included,
and unlabelled so the default Slack route keeps receiving them. Per-project
rule ownership is what the Prometheus Operator's `PrometheusRule` CRD is for;
it costs roughly 200 MB more and a migration.

**promtail and `loki-stack` are both deprecated upstream** in favour of Grafana
Alloy and the `loki` chart. Keeping them through this move is intentional:
changing the collector and the namespace in one step is how a day disappears.
Migrating is a clean follow-up, and the logs are already arriving.
