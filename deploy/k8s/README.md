# Deploying Sightline on Kubernetes

Kustomize, a base and a `prod` overlay, for a single-node k3s cluster behind a
Cloudflare tunnel.

```bash
kubectl kustomize deploy/k8s/prod            # render
kubectl apply --dry-run=server -k deploy/k8s/prod   # validate against the real API server
kubectl apply -k deploy/k8s/prod             # deploy
```

What is where:

|                           |                                                                 |
| ------------------------- | --------------------------------------------------------------- |
| `base/datastores.yaml`    | the Postgres StatefulSet, one replica                           |
| `base/app.yaml`           | the migrate Job, then `api`, `worker` and `web`                 |
| `base/networkpolicy.yaml` | default-deny ingress, then the flows that exist                 |
| `base/backup.yaml`        | nightly `pg_dump`, encrypted to a key the cluster does not hold |
| `prod/cloudflared.yaml`   | the tunnel — no inbound port, no static IP                      |

## Before you deploy: this needs about 1.5 GB

Postgres, two API replicas and a worker want roughly 1.5 GB between them. The
worker is the one that grows: it holds a scan's inventory in memory while it is
analysed, so a very large account needs its limit raised in `base/app.yaml`.

## Images

This cluster has no registry (`/etc/rancher/k3s/registries.yaml` does not
exist), so images are built locally and imported into containerd directly:

```bash
docker build --target api -t sightline-api:dev .
docker build --target web -t sightline-web:dev .

docker save sightline-api:dev | sudo k3s ctr images import -
docker save sightline-web:dev | sudo k3s ctr images import -
```

`imagePullPolicy` is deliberately left at its default. An explicit tag with the
image already present does not pull, so there is nothing to override — and
setting `Never` would make a future move to a registry fail confusingly.

Re-importing an image with the same tag does **not** restart the pods. Either
bump the tag in `base/kustomization.yaml` (`images:`) or
`kubectl -n sightline rollout restart deploy/api deploy/worker deploy/web`.

## Reaching it without a domain (testing only)

`prod/cloudflared.yaml` runs a **named** tunnel, which needs a domain on
Cloudflare. To try the hosted path before buying one, a **quick** tunnel gives
a random `https://<words>.trycloudflare.com` hostname for free:

```bash
# The named tunnel has no token yet, so stop it trying.
kubectl -n sightline scale deploy/cloudflared --replicas=0

# A quick tunnel, wearing BOTH labels the NetworkPolicy expects.
kubectl -n sightline run quicktunnel --image=cloudflare/cloudflared:2026.10.3 \
  --labels='app.kubernetes.io/name=cloudflared,app.kubernetes.io/part-of=sightline' \
  --restart=Never -- tunnel --no-autoupdate --url http://web:80

kubectl -n sightline logs -f quicktunnel | grep -m1 trycloudflare.com
```

Two things about it that are easy to lose an hour to:

- **Both labels, and the second is easy to miss.** `web-from-tunnel-only`
  permits ingress to the web pods only from pods matching its `from` selector -
  and `commonLabels` injects `app.kubernetes.io/part-of: sightline` into that
  selector as well, so it matches on _both_ labels. The deployed `cloudflared`
  gets both from kustomize; a pod created by hand gets only what `--labels`
  passes, which replaces the default `run=` label rather than adding to it. With
  one label the tunnel registers with Cloudflare and every request is a 502.
  Read the tunnel's own log first: k3s's policy controller REJECTs rather than
  drops, so a denial appears as `connect: connection refused`, which is how you
  tell it from an origin that is actually down. A pod already running with the
  wrong labels can be fixed in place - labels are mutable and the policy
  re-evaluates in about a second, so the hostname survives:
  `kubectl -n sightline label pod quicktunnel app.kubernetes.io/part-of=sightline`.
- **The hostname is not known until it starts**, and `PUBLIC_BASE_URL` has to
  match it exactly — it is the OAuth redirect's origin. So the order is: start
  the tunnel, read the hostname from the log, put it in the secret, restart the
  API. And a quick tunnel gets a _new_ hostname every restart, which is the
  reason production uses a named one: the redirect URI an OAuth provider has
  registered cannot change every time a pod moves.

Google accepts a `trycloudflare.com` subdomain as a redirect URI —
`trycloudflare.com` is on the Public Suffix List, so `<words>.trycloudflare.com`
is a registrable domain rather than somebody else's subdomain.

## Secrets

`sealed-secrets` is already installed in `kube-system`, and `kubeseal` is on
this machine. Nothing in this repository contains a credential, and
`prod/kustomization.yaml` leaves `secrets.sealed.yaml` commented out until you
create it — a placeholder with fake values would deploy, start, and fail at the
first sign-in with an error about Google rather than about configuration.

Five secrets are needed. Create each locally, seal it, commit the sealed
version, and delete the plaintext. They are split by who needs what: only the
migrate Job holds the database owner, and only the worker holds the identity
that can assume customers' roles. The API, which faces the internet, holds
neither.

**For a throwaway test, skip `kubeseal`.** Drop the `--dry-run=client -o yaml`
and the pipe, and `kubectl create secret generic` applies the secret straight
to the cluster, committing nothing. Sealing is for when these manifests are the
source of truth and a rebuilt cluster has to reproduce them; the secret names
and keys are identical either way.

```bash
# 1. The database's own credentials.
kubectl -n sightline create secret generic sightline-db --dry-run=client -o yaml \
  --from-literal=POSTGRES_DB=sightline \
  --from-literal=POSTGRES_USER=sightline \
  --from-literal=POSTGRES_PASSWORD="$(openssl rand -base64 24)" \
\
  | kubeseal --format yaml > /tmp/db.sealed.yaml

# 2. What the API and the worker need. DATABASE_URL is the cross-tenant
#    sightline_system role, not the owner: it reaches every tenant's rows for
#    sign-in and the job queue, and cannot change the schema. DATABASE_URL_APP
#    is the restricted role row-level security applies to; hosted mode refuses
#    to start without it. KMS_* is an IAM user allowed only kms:Encrypt and
#    kms:Decrypt on AWS_KMS_KEY_ID.
kubectl -n sightline create secret generic sightline-app --dry-run=client -o yaml \
  --from-literal=DATABASE_URL="postgres://sightline_system:<system-password>@postgres:5432/sightline" \
  --from-literal=DATABASE_URL_APP="postgres://sightline_app:<app-password>@postgres:5432/sightline" \
\
  --from-literal=KMS_ACCESS_KEY_ID=... \
  --from-literal=KMS_SECRET_ACCESS_KEY=... \
  --from-literal=SESSION_SECRET="$(openssl rand -base64 48)" \
  --from-literal=PUBLIC_BASE_URL="https://sightline.example.com" \
  --from-literal=GOOGLE_CLIENT_ID=... \
  --from-literal=GOOGLE_CLIENT_SECRET=... \
  --from-literal=AWS_KMS_KEY_ID=arn:aws:kms:... \
  --from-literal=SCANNER_PRINCIPAL_ARN=arn:aws:iam::...:user/SightlineScanner \
  --from-literal=ROLE_TEMPLATE_URL=https://.../readonly-role.yaml \
  --from-literal=ANTHROPIC_API_KEY=... \
  | kubeseal --format yaml > /tmp/app.sealed.yaml

# 3. The owner, for the migrate Job only. Its DATABASE_URL overrides the one in
#    sightline-app for that Job and nothing else.
kubectl -n sightline create secret generic sightline-db-owner --dry-run=client -o yaml \
  --from-literal=DATABASE_URL="postgres://sightline:<password>@postgres:5432/sightline" \
  | kubeseal --format yaml > /tmp/owner.sealed.yaml

# 4. The scanner identity, for the worker only: the IAM user named by
#    SCANNER_PRINCIPAL_ARN, allowed sts:AssumeRole on customers' roles. The
#    API sends connection checks to the worker rather than holding this.
kubectl -n sightline create secret generic sightline-scanner --dry-run=client -o yaml \
  --from-literal=AWS_ACCESS_KEY_ID=... \
  --from-literal=AWS_SECRET_ACCESS_KEY=... \
  | kubeseal --format yaml > /tmp/scanner.sealed.yaml

# 5. The tunnel token, from the Cloudflare dashboard.
kubectl -n sightline create secret generic sightline-tunnel --dry-run=client -o yaml \
  --from-literal=TUNNEL_TOKEN=... \
  | kubeseal --format yaml > /tmp/tunnel.sealed.yaml

cat /tmp/*.sealed.yaml > deploy/k8s/prod/secrets.sealed.yaml
rm /tmp/db.sealed.yaml /tmp/app.sealed.yaml /tmp/owner.sealed.yaml \
  /tmp/scanner.sealed.yaml /tmp/tunnel.sealed.yaml
```

Then uncomment `secrets.sealed.yaml` in `prod/kustomization.yaml`.

The two database roles get their passwords from `npm run db:app-role`, run
once with the owner's `DATABASE_URL` plus `DATABASE_URL_APP` and
`DATABASE_URL_SYSTEM` set to the URLs above. It also checks that each role has
exactly the privileges it should.

**Upgrading a cluster created with three secrets.** Nothing breaks: the two new
secrets are optional, so until they exist every pod runs as before, and the API
logs a warning naming each credential it holds but does not need. Create
`sightline-db-owner` and `sightline-scanner`, then change `sightline-app`'s
`DATABASE_URL` to the system role and move the AWS keys out of it.

A sealed secret is encrypted to _this cluster's_ controller key. It is safe in a
public repository and it is useless to anyone else — including you, on a rebuilt
cluster. Back up the controller's key, or keep the plaintext somewhere you
trust, or a cluster rebuild means regenerating every credential above.

### The restricted database role

The RLS migration creates `sightline_app` with **no password**, deliberately: a
password in a migration is a password in git. Set it after the migrate Job has
run and before the API pods are ready:

```bash
kubectl -n sightline exec deploy/api -- npm run db:app-role -w @sightline/api
```

That reads `DATABASE_URL_APP`, sets the role's password to match, and then
_proves_ it can connect and that row-level security applies to it.

## Row-level security, and why the role matters

`DATABASE_URL` is the table owner. On this project's own compose file that role
is a **superuser**, and superusers ignore RLS entirely — `FORCE ROW LEVEL
SECURITY` does not change it, because FORCE only binds the owner. Policies
installed against a superuser connection are decoration: they appear in `\d`,
they filter nothing, and nothing anywhere says so.

So `DATABASE_URL_APP` is a separate, unprivileged role, and the hosted
invariants refuse to start without it. `apps/api/src/db/rowLevelSecurity.test.ts`
asserts the whole property — including that the configured role has neither
`SUPERUSER` nor `BYPASSRLS` — and provisions its own login role so it runs in
CI whether or not CI is configured for it.

## Is NetworkPolicy actually enforced?

It is implemented by the CNI, and a cluster whose CNI ignores it accepts every
policy object and enforces none — `kubectl get netpol` looks identical either
way. This is the most misleading failure mode in Kubernetes networking, so
check rather than assume:

```bash
kubectl -n sightline run np-server --image=busybox:1.36 \
  --labels='app.kubernetes.io/name=np-server' --restart=Never \
  --command -- sh -c 'mkdir -p /www && echo hi > /www/index.html && httpd -f -p 8080 -h /www'
kubectl -n sightline wait --for=condition=Ready pod/np-server --timeout=90s
IP=$(kubectl -n sightline get pod np-server -o jsonpath='{.status.podIP}')

probe() {
  kubectl -n sightline delete pod np-client --ignore-not-found --wait >/dev/null
  kubectl -n sightline run np-client --image=busybox:1.36 --restart=Never --command -- \
    sh -c "wget -q -T 5 -O- http://$IP:8080 >/dev/null 2>&1 && echo REACHED || echo BLOCKED" >/dev/null
  kubectl -n sightline wait --for=jsonpath='{.status.phase}'=Succeeded pod/np-client --timeout=90s >/dev/null
  kubectl -n sightline logs np-client
}

probe   # expect REACHED
kubectl -n sightline apply -f - <<'YML'
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: np-probe }
spec:
  podSelector: { matchLabels: { app.kubernetes.io/name: np-server } }
  policyTypes: [Ingress]
YML
sleep 4 && probe   # expect BLOCKED
kubectl -n sightline delete netpol np-probe
kubectl -n sightline delete pod np-server np-client --ignore-not-found
```

On the k3s cluster this was written against (v1.36.4+k3s1, no separate CNI
policy pod) the answer was **yes**: REACHED, then BLOCKED, then REACHED again
once the policy was removed. k3s ships a policy controller unless started with
`--disable-network-policy`.

## Backups

`base/backup.yaml` dumps Postgres nightly at 03:15 and encrypts the dump to an
X.509 certificate in a ConfigMap. The certificate is public; **the private key
must live off the cluster.** That asymmetry is the design: the job writes a
backup it cannot read, so taking the namespace gets an attacker the live
database — which they already had — and a pile of backups they cannot decrypt.

```bash
openssl req -x509 -newkey rsa:3072 -nodes -days 3650 \
  -subj "/CN=sightline-backup" -keyout backup-key.pem -out backup-cert.pem

kubectl -n sightline create configmap sightline-backup-key --from-file=backup-cert.pem
# Put backup-key.pem somewhere that is not this cluster and not this repository.
```

### Restoring

```bash
# Nothing long-running mounts the backups volume, so start a pod that does and
# copy through `exec`. Not `kubectl run -i`: when its attach fails it falls back
# to streaming logs and the file arrives twice over, which openssl reports as
# "header too long". This copies the newest dump; swap the `ls` to pick another.
kubectl -n sightline run backup-peek --restart=Never --image=busybox:1.36   --overrides='{"spec":{"volumes":[{"name":"b","persistentVolumeClaim":{"claimName":"backups"}}],
    "containers":[{"name":"p","image":"busybox:1.36","command":["sleep","600"],
    "volumeMounts":[{"name":"b","mountPath":"/b"}]}]}}'
kubectl -n sightline wait --for=condition=Ready pod/backup-peek
kubectl -n sightline exec backup-peek -- sh -c 'cat $(ls -t /b/*.enc | head -1)' > restore.enc
kubectl -n sightline delete pod backup-peek

openssl smime -decrypt -binary -inform DER -in restore.enc \
  -inkey backup-key.pem -out restore.dump

kubectl -n sightline exec -i statefulset/postgres -- \
  pg_restore --no-owner --no-privileges --exit-on-error \
    -U sightline -d sightline_restored < restore.dump
```

Restore into a **new** database first and look at it, rather than over the live
one.

`scripts/backup-restore-test.sh` runs this whole path locally against the
development Postgres and checks the thing that actually matters: an ExternalId
encrypted before the backup still decrypts after it. Row counts prove a dump
was not truncated; they do not prove it is _usable_, and an ExternalId that
cannot be decrypted means every customer redeploys their CloudFormation stack.
The script also asserts the RLS policies come back — a restore that returned the
data without them would look perfectly healthy and silently stop isolating
tenants.

Run it after any change to the backup command. It is verified to fail when
encryption is accidentally a passthrough, and when the restore loses a policy.

## Monitoring

Prometheus, Grafana and Loki are a separate chart in a separate namespace —
[`helm/monitoring/README.md`](../../helm/monitoring/README.md) — because the
platform serves every application on the cluster rather than this one. What is
_here_ is the application's half: the scrape annotations on the `api` Service
and the `worker` pods, a NetworkPolicy opening port 9464 to the monitoring
namespace and nothing else, the dashboards generated into a labelled ConfigMap
by `base/kustomization.yaml`, and the backup job's push to the Pushgateway.

The metrics port is deliberately not the application port and is not proxied by
nginx, so it is unreachable through the tunnel by construction.
`infra/metricsScrape.test.ts` holds those four files to one port number and
fails if nginx ever starts routing it.

## Not in these manifests

- **Cloudflare WAF and rate limits** on `/api/auth/*` and `/api/scans`, and
  Access on `/admin`. These are dashboard or Terraform configuration against
  Cloudflare's API, not Kubernetes objects, so they are not here — and the
  application's own per-tenant limits are in `apps/api/src/tenancy/limits.ts`
  rather than relying on the edge for correctness.
- **Copying backups off the machine.** The CronJob writes to a PVC on the same
  node as the database, which survives a lost database and not a lost disk. The
  job reads `BACKUP_S3_DESTINATION` and says so if it is set, because the
  `postgres` image has no `aws` CLI and adding a package to a backup job adds a
  way for the backup job to fail; the right shape is a second container with the
  CLI, sharing the volume.
- **A second node.** Every StatefulSet here is one replica, and that is honest
  rather than hidden: neither datastore is replicated, so this is a single point
  of failure whose mitigation is a tested restore.
