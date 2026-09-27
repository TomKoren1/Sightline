# `argocd/`

One Application, bootstrapped once:

```bash
kubectl apply -f argocd/application.yaml
```

From then on ArgoCD is the only thing that applies changes to the `daveio`
release. CI builds images, bumps the tag in `helm/daveio/values.yaml`, and
ArgoCD syncs the change — nothing in the pipeline touches the cluster
directly, so the cluster's state stays a function of the repository rather
than of whoever ran a job last.

## Two deliberate settings

**`prune: false`.** Pruning would delete the PersistentVolumeClaims holding
Postgres and Neo4j the moment a template was renamed or removed. That is the
one mistake in this chart that loses customer data rather than causing
downtime, and `selfHeal` — which is on — already covers the case that matters
day to day: somebody changing something by hand in the cluster.

**`ignoreDifferences` on `volumeClaimTemplates`.** They are immutable after
creation and Kubernetes rewrites parts of them, producing a permanent
out-of-sync that trains people to ignore the sync status.

## Before the first sync

The repository is private, so ArgoCD needs credentials for it:

```bash
argocd repo add https://github.com/TomKoren1/dave.io_home-assignment.git \
  --username <user> --password <token>
```

And the SealedSecrets have to exist — `helm/daveio/README.md` has the
`kubeseal` commands. The chart ships placeholders, so a sync without them
brings up pods that fail to start rather than pods running with default
credentials, which is the right way round.
