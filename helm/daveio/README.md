# `helm/daveio`

The hosted deployment: API, scan worker, frontend, Postgres, Neo4j, the demo
account, the Cloudflare tunnel and a nightly backup.

Nothing observability is installed here. The cluster already runs Prometheus,
Grafana and Loki — two Prometheus instances scraping the same pods is a bill
and a confusion, not redundancy — so the API pod carries
`prometheus.io/scrape` annotations and the dashboard lives in
[`deploy/`](../../deploy).

```bash
helm lint helm/daveio
helm template dave helm/daveio          # read it before applying it
helm upgrade --install dave helm/daveio
```

## Secrets

`templates/secrets-sealedsecret.yaml` ships a **placeholder**, so the chart
renders and the API's checksum annotation has something to hash. Replace it
with a real SealedSecret before deploying — encrypted with the cluster's public
key, safe to commit, and the same mechanism the sibling project uses:

```bash
kubectl create secret generic dave-daveio-secrets \
  --dry-run=client -o yaml \
  --from-literal=POSTGRES_PASSWORD="$(openssl rand -base64 24)" \
  --from-literal=NEO4J_PASSWORD="$NEO4J_PASSWORD" \
  --from-literal=NEO4J_AUTH="neo4j/$NEO4J_PASSWORD" \
  --from-literal=SESSION_SECRET="$(openssl rand -base64 48)" \
  --from-literal=GOOGLE_CLIENT_ID="$GOOGLE_CLIENT_ID" \
  --from-literal=GOOGLE_CLIENT_SECRET="$GOOGLE_CLIENT_SECRET" \
  --from-literal=AWS_KMS_KEY_ID="$AWS_KMS_KEY_ID" \
  --from-literal=AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID" \
  --from-literal=AWS_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY" \
  | kubeseal --controller-name=sealed-secrets --controller-namespace=kube-system \
      -o yaml > helm/daveio/templates/secrets-sealedsecret.yaml
```

and the tunnel token separately:

```bash
kubectl create secret generic dave-daveio-cloudflared \
  --dry-run=client -o yaml --from-literal=TUNNEL_TOKEN="$TUNNEL_TOKEN" \
  | kubeseal --controller-name=sealed-secrets --controller-namespace=kube-system \
      -o yaml > helm/daveio/templates/cloudflared-sealedsecret.yaml
```

A plain `Secret` with real values must never be committed: base64 is not
encryption, and this repository's gitleaks job would fail the build — which is
the intended outcome, not an obstacle.

Where each value comes from is in
[`docs/HOSTED-SETUP.md`](../../docs/HOSTED-SETUP.md).

## Things worth knowing before the first deploy

**`AWS_ACCESS_KEY_ID` must be the platform identity's real key.** Hosted mode
refuses to start if it looks like a placeholder, because a mock key sits first
in the SDK's credential chain and silently shadows the real identity. That
identity needs exactly two things: `sts:AssumeRole` on the scanner role name,
and `kms:Encrypt`/`Decrypt`/`DescribeKey` on the one key.

**`AWS_ENDPOINT_URL` must be unset.** It is an SDK-wide override that would
redirect every signed call, including ones made with credentials assumed inside
a customer account. The demo account uses `DEMO_AWS_ENDPOINT_URL`, which the
chart points at the in-cluster moto Service and which applies only to tenants
who switched to the demo (ADR-015, ADR-020).

**`config.publicBaseUrl` must match the redirect URI registered with Google,
exactly** — scheme, host and no trailing slash. A mismatch is
`redirect_uri_mismatch`, and the message does not say which end is wrong.

**The worker is one replica, `Recreate`.** Several are safe — the queue claims
with `FOR UPDATE SKIP LOCKED` and a partial unique index keeps one scan per
tenant — but an overlap during a rollout means a scan interrupted mid-flight
waiting for the reaper, which is an avoidable orphan.

**The backup writes to a PVC, not to object storage.** That is a defence
against a dropped table, not against losing the disk, and an untested backup is
a belief: restore one on purpose before relying on it.

## What is not here yet

`docs/HOSTED-PLAN.md` tracks the rest. The notable gaps: scan progress is
streamed by the API process that runs the scan, so a scan the _worker_ picks up
reports progress only when it finishes; and there is no ArgoCD Application or
image-building workflow yet, so images are built and tags set by hand.
