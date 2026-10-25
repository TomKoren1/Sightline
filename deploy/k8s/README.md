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
| `staging/`                | the same base in `sightline-staging`, for rehearsing a release  |

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

Since the image is compiled (`apps/api/build.mjs`), the API, worker and
migrate Job run `node apps/api/dist/<entry>.js`, and the image has no npm.
**Rebuild both images before applying manifests from this version:** an older
image has no `dist/` and the pods fail with "Cannot find module".

### Through ArgoCD

`argocd/sightline-prod.yaml` and `argocd/sightline-staging.yaml` reconcile the
two overlays the way `argocd/monitoring-application.yaml` does the chart. Apply
each once with `kubectl apply -f`; both sync by hand until you have watched a
sync work, then automated sync can be turned on. ArgoCD applies manifests and
builds nothing, so import a commit's images before syncing it.

### Rolling back

Re-import the previous image tag and restart; do not roll the database back.
Migrations only expand the schema - add tables, add nullable or defaulted
columns - so the previous release runs on the new schema unchanged.
`guards/migrationsExpand.test.ts` refuses a migration that drops, renames,
retypes or tightens a column unless the file states, on a `-- contract:`
line, why it is safe: the second half of expand-then-contract, shipped a
release after nothing reads the old shape. Restoring a backup is for lost
data, not for a bad release.

## Staging

`staging/` deploys the same base into `sightline-staging` on the same node, so a
release can be rehearsed — the new image, its migrations, even a restored copy of
prod's data — before prod runs it. It differs from prod only where it must: its
own namespace and image tag, one replica of each (about 1 GB beside prod), no
backups, no second copy of the dashboards, and no tunnel. Nobody else should
reach a staging copy, so it is reached through `kubectl port-forward` on
loopback, which hosted mode accepts over plain http.

```bash
# 1. Build the candidate under the staging tag, which prod never runs.
docker build --target api -t sightline-api:staging .
docker build --target web -t sightline-web:staging .
docker save sightline-api:staging | sudo k3s ctr images import -
docker save sightline-web:staging | sudo k3s ctr images import -

# 2. Its own secrets, the same five names as prod's in the new namespace
#    (see Secrets below). Two values differ: PUBLIC_BASE_URL is
#    http://localhost:8081, and sign-in needs a second GitHub OAuth app whose
#    callback is http://localhost:8081/api/auth/github/callback. The KMS key and
#    its key pair can be prod's.
kubectl create namespace sightline-staging

# 3. Deploy, then give the database roles their passwords, as for prod.
kubectl apply -k deploy/k8s/staging
kubectl -n sightline-staging wait --for=condition=complete job/sightline-migrate --timeout=5m

# 4. Open it: on the server, then tunnel the port to your own machine.
kubectl -n sightline-staging port-forward svc/web 8081:80
ssh -L 8081:localhost:8081 <server>        # from your machine; open http://localhost:8081
```

To rehearse against real data, restore prod's newest backup into staging's
Postgres with the steps under [Restoring](#restoring), using
`-n sightline-staging`. When the candidate is good, promote the same image
rather than rebuilding it — `docker tag sightline-api:staging sightline-api:dev`
(and the web image), import both, rerun prod's migrations with
`kubectl -n sightline delete job sightline-migrate && kubectl apply -k deploy/k8s/prod`,
then `kubectl -n sightline rollout restart deploy/api deploy/worker deploy/web`.

Staging holds memory while idle, so pause it between releases with
`kubectl -n sightline-staging scale deploy,statefulset --all --replicas=0`.

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
`prod/kustomization.yaml` leaves `secrets.sealedsecret.yaml` commented out until
you create it — a placeholder with fake values would deploy, start, and fail at
the first sign-in with an error about Google rather than about configuration.
The name must end in `sealedsecret.yaml`: that is the path `.gitleaks.toml`
exempts, and CI's secret scan fails on the ciphertext of any other.

**When the secrets already exist in the cluster**, made by hand, seal them as
they are rather than retyping them:

```bash
scripts/seal-prod-secrets.sh   # reads the live secrets, writes prod/secrets.sealedsecret.yaml

# The controller will not overwrite a Secret it did not create. This lets it
# adopt each one; until then the SealedSecret reports "already exists and is
# not managed by SealedSecret" and the live Secret is left as it was.
for s in sightline-db sightline-app sightline-db-owner sightline-scanner; do
  kubectl -n sightline annotate secret "$s" sealedsecrets.bitnami.com/managed=true
done
```

Then uncomment the file in `prod/kustomization.yaml`, commit both, and sync.
The script keeps only the keys the manifests use, so a key left from a removed
component disappears from the live Secret when the controller adopts it.

**Starting from nothing**, create each secret, seal it and commit the result.
This cluster's controller Service is `sealed-secrets`, not kubeseal's default
`sealed-secrets-controller`, so every `kubeseal` needs it named:

Five secrets are needed (four while the tunnel is the quick one). Create each
locally, seal it, commit the sealed version, and delete the plaintext. They are split by who needs what: only the
migrate Job holds the database owner, and only the worker holds the identity
that can assume customers' roles. The API, which faces the internet, holds
neither.

**For a throwaway test, skip `kubeseal`.** Drop the `--dry-run=client -o yaml`
and the pipe, and `kubectl create secret generic` applies the secret straight
to the cluster, committing nothing. Sealing is for when these manifests are the
source of truth and a rebuilt cluster has to reproduce them; the secret names
and keys are identical either way.

```bash
KUBESEAL="--controller-name sealed-secrets --controller-namespace kube-system"

# 1. The database's own credentials.
kubectl -n sightline create secret generic sightline-db --dry-run=client -o yaml \
  --from-literal=POSTGRES_DB=sightline \
  --from-literal=POSTGRES_USER=sightline \
  --from-literal=POSTGRES_PASSWORD="$(openssl rand -base64 24)" \
\
  | kubeseal $KUBESEAL --format yaml > /tmp/db.sealed.yaml

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
  | kubeseal $KUBESEAL --format yaml > /tmp/app.sealed.yaml

# 3. The owner, for the migrate Job only. Its DATABASE_URL overrides the one in
#    sightline-app for that Job and nothing else.
kubectl -n sightline create secret generic sightline-db-owner --dry-run=client -o yaml \
  --from-literal=DATABASE_URL="postgres://sightline:<password>@postgres:5432/sightline" \
  | kubeseal $KUBESEAL --format yaml > /tmp/owner.sealed.yaml

# 4. The scanner identity, for the worker only: the IAM user named by
#    SCANNER_PRINCIPAL_ARN, allowed sts:AssumeRole on customers' roles. The
#    API sends connection checks to the worker rather than holding this.
kubectl -n sightline create secret generic sightline-scanner --dry-run=client -o yaml \
  --from-literal=AWS_ACCESS_KEY_ID=... \
  --from-literal=AWS_SECRET_ACCESS_KEY=... \
  | kubeseal $KUBESEAL --format yaml > /tmp/scanner.sealed.yaml

# 5. The tunnel token, from the Cloudflare dashboard.
kubectl -n sightline create secret generic sightline-tunnel --dry-run=client -o yaml \
  --from-literal=TUNNEL_TOKEN=... \
  | kubeseal $KUBESEAL --format yaml > /tmp/tunnel.sealed.yaml

cat /tmp/*.sealed.yaml > deploy/k8s/prod/secrets.sealedsecret.yaml
rm /tmp/db.sealed.yaml /tmp/app.sealed.yaml /tmp/owner.sealed.yaml \
  /tmp/scanner.sealed.yaml /tmp/tunnel.sealed.yaml
```

Then uncomment `secrets.sealedsecret.yaml` in `prod/kustomization.yaml`.

The two database roles get their passwords from `npm run db:app-role`, run
once with the owner's `DATABASE_URL` plus `DATABASE_URL_APP` and
`DATABASE_URL_SYSTEM` set to the URLs above. It also checks that each role has
exactly the privileges it should.

**Upgrading a cluster created with three secrets.** Nothing breaks: the two new
secrets are optional, so until they exist every pod runs as before, and the API
logs a warning naming each credential it holds but does not need. Create
`sightline-db-owner` and `sightline-scanner`, then change `sightline-app`'s
`DATABASE_URL` to the system role and move the AWS keys out of it.

### No access keys at all: IAM Roles Anywhere

The scanner's access key is the most valuable secret here: it can assume every
customer's role, and it never expires. Roles Anywhere swaps it for a
certificate the worker presents for credentials that last an hour. It is free
with a CA of your own, which `scripts/roles-anywhere-ca.sh` makes; only AWS
Private CA would cost money. The API gets its own certificate and a role that
can only use the KMS key, so the two pods stay apart as they do today.

```bash
# 1. A CA and a certificate per pod. Keep roles-anywhere/ca.key off the cluster.
scripts/roles-anywhere-ca.sh init
scripts/roles-anywhere-ca.sh issue worker
scripts/roles-anywhere-ca.sh issue api

# 2. Trust the CA. The ARN this prints is the trust anchor.
aws rolesanywhere create-trust-anchor --name sightline --enabled \
  --source "sourceType=CERTIFICATE_BUNDLE,sourceData={x509CertificateData=$(cat roles-anywhere/ca.pem)}"
```

3. Two roles, each trusting `rolesanywhere.amazonaws.com` for one certificate
   subject. `SightlineScanner`'s trust policy:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Principal": { "Service": "rolesanywhere.amazonaws.com" },
         "Action": ["sts:AssumeRole", "sts:TagSession", "sts:SetSourceIdentity"],
         "Condition": {
           "StringEquals": { "aws:PrincipalTag/x509Subject/CN": "sightline-worker" },
           "ArnEquals": { "aws:SourceArn": "<trust anchor ARN>" }
         }
       }
     ]
   }
   ```

   Its permissions: `sts:AssumeRole` and `sts:SetSourceIdentity` on
   `arn:aws:iam::*:role/SightlineReadOnlyRole`, plus `kms:Encrypt` and
   `kms:Decrypt` on the key. `SightlineKms` is the same with CN `sightline-api`,
   and only the two KMS actions.

```bash
# 4. A profile naming both roles. The ARN it prints is the profile.
aws rolesanywhere create-profile --name sightline --enabled \
  --role-arns arn:aws:iam::<account>:role/SightlineScanner arn:aws:iam::<account>:role/SightlineKms

# 5. Hand each pod its certificate, and say where it is and what to ask for.
for who in worker api; do
  kubectl -n sightline create secret generic sightline-roles-anywhere-$who \
    --from-file=certificate.pem=roles-anywhere/$who.pem \
    --from-file=private-key.pem=roles-anywhere/$who.key
done
kubectl -n sightline create configmap sightline-roles-anywhere \
  --from-literal=certificate=/etc/sightline/roles-anywhere/certificate.pem \
  --from-literal=privateKey=/etc/sightline/roles-anywhere/private-key.pem \
  --from-literal=trustAnchorArn=<trust anchor ARN> \
  --from-literal=profileArn=<profile ARN> \
  --from-literal=workerRoleArn=arn:aws:iam::<account>:role/SightlineScanner \
  --from-literal=apiRoleArn=arn:aws:iam::<account>:role/SightlineKms

# 6. The scanner is now a role, so customers' trust policies name it.
#    Set SCANNER_PRINCIPAL_ARN in sightline-app to the SightlineScanner ARN,
#    then delete sightline-scanner and remove KMS_* from sightline-app.
kubectl -n sightline rollout restart deploy/api deploy/worker
```

Existing customers' stacks name the old scanner user, so keep that user until
each has updated its stack with the new principal. Certificates last a year:
both processes log a warning from thirty days out, and
`scripts/roles-anywhere-ca.sh issue worker` plus a new secret renews one
without touching AWS. Hosted mode refuses to start with only some of the five
`ROLES_ANYWHERE_*` values set.

A sealed secret is encrypted to _this cluster's_ controller key. It is safe in a
public repository and it is useless to anyone else — including you, on a rebuilt
cluster. Back up the controller's key, or keep the plaintext somewhere you
trust, or a cluster rebuild means regenerating every credential above.

### The restricted database role

The RLS migration creates `sightline_app` with **no password**, deliberately: a
password in a migration is a password in git. Set it after the migrate Job has
run and before the API pods are ready:

```bash
kubectl -n sightline exec deploy/api -- node apps/api/dist/app-role.js
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

### Copies off the machine

The CronJob writes to a volume on the same node as the database, which
survives losing the database but not losing the node. `scripts/backup-pull.sh`
copies every encrypted dump to another machine you own: a laptop, a NAS, a
second server. It is free and needs nothing new on the cluster. Run it from
that machine's cron, or from Task Scheduler on Windows through Git Bash:

```bash
# Through ssh, as this cluster is reached; any kubectl that reaches it works.
KUBECTL="ssh tom@server sudo k3s kubectl" BACKUP_PULL_DIR=~/sightline-backups BACKUP_KEY=~/keys/backup-key.pem   scripts/backup-pull.sh

# crontab -e, daily after the 03:15 backup:
# 45 4 * * * cd ~/sightline && KUBECTL="ssh tom@server sudo k3s kubectl" scripts/backup-pull.sh
```

It starts a throwaway pod that mounts the volume read-only. It copies only
what is new, checks each copy against the cluster's SHA-256 before keeping it,
and deletes local copies older than `KEEP_DAYS` (30, the age by which
[PRIVACY.md](../../PRIVACY.md) promises a deleted account has left every backup). Where the machine holds
the backup's private key, which belongs off the cluster anyway, it also
decrypts the newest copy and checks it is a Postgres dump. It exits non-zero on
any failure, so cron's mail or the scheduler's history is the alert.

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

## Recovery objectives

What a failure costs, with the backups above and nothing more:

| Failure                          | Data lost (RPO)                      | Back in service (RTO)                          |
| -------------------------------- | ------------------------------------ | ---------------------------------------------- |
| A pod, or the API or worker      | none                                 | seconds: the Deployment replaces it            |
| Postgres's data, the node intact | up to 24 hours: since the 03:15 dump | under an hour: restore above, then rescan      |
| The node, or its disk            | up to 24 hours, from the pulled copy | a few hours: new node, k3s, manifests, restore |
| The node, with no pulled copy    | everything not re-derivable (below)  | as above, and every customer reconnects        |

Not all data is equal. **The inventory is re-derivable**: a scan rebuilds
every resource, relationship and finding from AWS, so for it the effective RPO
is zero once each account is rescanned. What a scan cannot rebuild, and the
backups exist for, is the rest: tenants and members, connections and their
encrypted ExternalIds (losing one means that customer redeploys their
CloudFormation stack), accepted findings and their reasons, conversations, and
the audit log.

Three things a rebuild needs that live outside the database, and so outside
these backups - keep each off the cluster:

- **The backup private key** (`backup-key.pem`), without which every dump is
  unreadable.
- **The sealed-secrets controller key**, without which none of the sealed
  secrets in `prod/` decrypt on a new cluster:
  `kubectl -n kube-system get secret -l sealedsecrets.bitnami.com/sealed-secrets-key -o yaml > sealed-secrets-key.yaml`,
  and `kubectl apply -f` it before installing the controller on the new one.
- **The KMS key** in AWS, which holds every ExternalId's data key. It survives a
  cluster loss by construction; do not schedule its deletion with a cluster.

Rehearse a restore - `scripts/backup-restore-test.sh` locally, and once a
quarter into staging - because an untested backup is a hope, and the RTO above
assumes someone has done it before.

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
`guards/metricsScrape.test.ts` holds those four files to one port number and
fails if nginx ever starts routing it.

## Not in these manifests

- **Cloudflare WAF and rate limits** on `/api/auth/*` and `/api/scans`, and
  Access on `/admin`. These are dashboard or Terraform configuration against
  Cloudflare's API, not Kubernetes objects, so they are not here — and the
  application's own per-tenant limits are in `apps/api/src/tenancy/limits.ts`
  rather than relying on the edge for correctness.
- **A second node.** Every StatefulSet here is one replica, and that is honest
  rather than hidden: neither datastore is replicated, so this is a single point
  of failure whose mitigation is a tested restore.
