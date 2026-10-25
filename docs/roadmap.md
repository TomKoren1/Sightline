# Limits and what is next

Every limit here is one that can be pointed at in the code, and every fix is
one the design already leaves room for. Written against what is built, so
when something here gets built, this file changes in the same pull request.

## What breaks first on a large account

1. **Writing the graph.** Each scan writes its whole inventory and graph into
   a scope of its own, and `scan_runs.projected_at` makes it current once
   everything is in, so a reader never sees half a scan. Commits are batched
   and heap use is flat - the nightly load test holds 50,000 resources to a
   time and memory budget - but the work is still proportional to the whole
   account, every scan, and the superseded scope has to be swept afterwards.
   _Fix:_ diff against the previous snapshot, which is already stored, and
   write only what changed. That is also what would make scans cheap enough
   to run continuously.
2. **Scan wall-clock across many regions.** The work is every service in every
   enabled region. The Resource Explorer fast path asks one indexed query
   which regions hold anything and skips the rest, and a token bucket per
   account, service and region (`apps/api/src/aws/pace.ts`) keeps the scan
   under AWS's throttling rather than reacting to it. _Remaining:_
   concurrency per service rather than per scan, and splitting a unit that is
   much larger than the others - one region's S3 makes several calls per
   bucket.

What is already in place and gets _more_ useful with size: partial-failure
handling, so one refused region or service is reported rather than failing
the scan; credential renewal mid-scan; large accounts opening on their groups -
each VPC, then each kind of resource outside one - rather than drawing every
node; and tool results fitted to the model's context whole rows at a time,
saying what was cut.

## What is not built yet

- **Scheduled scans.** A scan runs when someone asks for one, so _"what changed
  overnight?"_ is only answerable if someone scanned last night.
- **Paths between accounts.** An AWS Organization connects with each member
  account scanned on its own, and each scan shows who outside the account can
  get in - roles another account may assume, policies granting one. What the
  other account can then reach is in its own scan; a path is not followed from
  one account's graph into the next.
- **Idle detection from usage.** The idle findings come from configuration - an
  unattached volume, an unassociated address. CloudWatch metrics and Cost
  Explorer would show what is configured but unused; the role already grants
  the read permissions for both.
- **A larger eval set, with a model judge.** The tier-2 cases are scored on the
  resources each answer cites. A judge would let them score the explanation as
  well, over more cases than are practical to grade by hand.

## The hosted deployment

Choices that cost nothing today and are deliberate gaps rather than oversights:

- **A quick tunnel, not a named one.** The public URL is a Cloudflare quick
  tunnel with a random address, so a restart of that pod changes the URL and
  the OAuth redirect with it. A named tunnel needs a domain; the manifests for
  it are in place at zero replicas (`deploy/k8s/prod/cloudflared.yaml`).
- **One node.** Postgres, its backups and the application share one machine.
  The backups are encrypted to a key the cluster does not hold, and the restore
  is tested (`scripts/backup-restore-test.sh`), but they are on the same disk
  as the database they protect.
