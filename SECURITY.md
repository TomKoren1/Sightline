# Security

Sightline reads a customer's AWS account. That is the whole product, so the
security properties below are not incidental to it — they are the design.

## Reporting a vulnerability

Open a [security advisory](https://github.com/TomKoren1/Sightline/security/advisories/new)
rather than a public issue. This is a personal project with no support
commitment, so there is no response-time guarantee; I will acknowledge what I
can act on and say so plainly when I cannot.

## What the project does, and does not, hold

**No long-lived AWS credentials, anywhere.** Access is by `sts:AssumeRole`
into a role the customer creates, and the session is held in memory only. The
role ARN and the ExternalId live in `.env`, which is git-ignored by a
deliberately broad pattern — anything env-shaped is ignored, and only
`.env.example` is re-included. CI fails if any environment file is tracked,
which is a check added after one was.

**Read-only by construction, not by convention.** The CloudFormation template
in [`infra/readonly-role.yaml`](infra/readonly-role.yaml) deliberately does
**not** attach AWS's `ReadOnlyAccess`: that policy grants roughly 7,000 actions
including data-plane reads — `s3:GetObject`, `dynamodb:GetItem`,
`ssm:GetParameter` — which an inventory product has no business holding.
Instead:

- `SecurityAudit` for configuration and policy reads, and
  `job-function/ViewOnlyAccess` for List/Describe enumeration;
- one inline policy enumerating the handful of calls those two miss, listed
  individually rather than behind a wildcard, so the permission set stays
  auditable;
- an explicit **Deny** on data-plane reads, attached by default
  (`AllowDataPlaneReads` defaults to `false`). An explicit Deny cannot be
  overridden by any Allow, including one a future AWS update might add to a
  managed policy. That is what makes "it can see your infrastructure but not
  your data" a property of the role rather than a claim about which policies
  happened to be attached the day it was written.

The trust policy requires the deployment's own role ARN as the principal, a
matching ExternalId, and a `SourceIdentity` matching `sightline-*` — the last
of which makes attribution mandatory rather than optional.

**One role per tenant, not one role per account.** A hosted deployment names
the role it asks for after the tenant asking —
`SightlineReadOnlyRole-<first 12 hex of the tenant id>` — and names the stack
the same way. Without that, two tenants connecting the same AWS account named
one role, and a role has one trust policy carrying one ExternalId: whichever
deployed its stack last owned the role and the other was refused permanently.
Two engineers at one company connecting their shared production account is the
first thing a real service meets. It failed safe — the second tenant could not
connect at all, rather than reading the first one's inventory — but a
limitation that presents as `AccessDenied` is one people diagnose as a bug for
an afternoon.

The platform's scanner identity therefore needs both forms in its policy,
because a role deployed before this change keeps the name it was created with
and connections pin the ARN they verified:

```json
"Resource": [
  "arn:aws:iam::*:role/SightlineReadOnlyRole",
  "arn:aws:iam::*:role/SightlineReadOnlyRole-*"
]
```

A self-hosted clone keeps the unsuffixed name. It has one tenant, so there is
nothing to disambiguate, and renaming would orphan the role every existing
install already deployed — including the one `npm run setup --disconnect`
deletes by name.

Remediation commands are _generated as text for an operator to run_ and are
never executed by the product.

**The agent cannot write.** Its curated tools are fixed `SELECT`s, and its one
escape hatch runs a parsed, allow-listed `SELECT` inside a `READ ONLY`
transaction with a statement timeout, so a write fails at the database rather
than being filtered by a prompt. The agent has no shell, no AWS client, and no
tool that mutates anything.

## The ExternalId

It defeats the [confused-deputy problem](https://docs.aws.amazon.com/IAM/latest/UserGuide/confused-deputy.html):
knowing the role ARN is not enough to assume it, so one customer cannot be
tricked into letting another's deployment in. It is a credential. `npm run setup`
masks it in terminal output and never rotates one that is already in use.

In a hosted deployment it is stored encrypted — AES-256-GCM through AWS KMS,
with versioned envelopes so a key can be rotated by adding one — and the
plaintext is held only for the length of an `AssumeRole`. The logger redacts it
by field name at every nesting depth, because the way a secret reaches a log is
not `log.info({ externalId })` but `log.info({ connection })` or
`log.info({ err })`, with the field arriving inside something somebody logged
whole.

It is returned to whoever owns the connection whenever they ask, which was a
reversal: it was once-only at first, and that is the reflex rather than the
reasoning. The value grants nothing without this service's own credentials,
their deployed stack holds it in plaintext in the trust policy where anyone who
can call `iam:GetRole` can read it, and hiding it made a failed deploy
unrecoverable without rotating a secret the stack already contained. It stays
out of the connection _list_, which renders on every page load.

## Multiple customers in one deployment

Running this as a service means one database holds several people's inventories,
and "every query filters by tenant" is a convention rather than a guarantee.
There are two independent mechanisms, which fail in different ways:

**The application cannot forget.** `TenantId`, `ConnectionId` and `ScanId` are
branded types, so passing an unscoped string where one is required is a compile
error rather than a code review. Adding them produced 75 of those errors, each
a call site reading data without saying whose. A resource's identity is
`(scanId, arn)` rather than `arn`, because some ARNs — the synthetic `Internet`
node — are the same constant for every customer, and a graph read keyed on the
ARN alone would attach one customer's relationships to another's resources.

**The database refuses anyway.** Row-level security policies on the nine tables
holding customer data compare every row against the tenant on the connection,
with `WITH CHECK` as well as `USING`, so an insert carrying another tenant's id
is refused rather than accepted and hidden. The application connects as a
restricted role for this to mean anything: `DATABASE_URL` is the table owner and
in the development compose file a superuser, and **superusers ignore RLS
entirely** — `FORCE ROW LEVEL SECURITY` does not change that, because FORCE only
binds the owner. Policies installed against a superuser connection are
decoration. Hosted mode refuses to start without the separate role.

A query that escapes its tenant context fails closed: it returns no rows rather
than another tenant's. The guards are asserted behaviourally, by seeding two
tenants and looking at what comes back, because the static and runtime checks
both pass a query that binds the right parameters and still leaks.

## Authentication

Google and GitHub OIDC. Users are matched on the provider's **subject**, never
on email — an email can change hands, and a provider's email is only trusted
when the provider says it is verified. Google's `id_token` gets an `aud` check,
because a token minted for a different application is genuinely from Google and
correctly signed.

Sessions are rows, so they can be revoked. The cookie carries an opaque random
token and only its SHA-256 is stored, so a database leak is not a session leak.

One guard is registered globally and a route escapes it only by saying
`@Public()`. That direction matters: a per-route guard is one a new route can
omit with nothing failing, whereas forgetting here makes the route refuse. Both
directions are asserted against the **real** Fastify route table.

### Roles inside a workspace

Each member has one role: viewer, member, admin or owner. Viewers read and ask
questions, members also run scans and accept findings, admins also connect
accounts and manage the team, and owners also delete the workspace and make
owners. The same global guard enforces them. A state-changing route that names
no role needs `member`, so a new route is protected unless it says otherwise,
and a test holds every mutating route in the real route table to a declared
role. A workspace always keeps an owner. People join by a single-use invite link
that lasts a week, whose token is stored only as a hash, and every invite, join,
role change and removal is written to the audit log.

A self-hosted clone has no sign-in, deliberately: it is one operator reading
their own account, and the `api` service publishes no host port — it is reachable
only through the `web` container. Publishing port 3000 yourself would expose the
graph to anyone who can reach it.

## Deleting an account

`DELETE /api/me`, confirmed by typing the account's own email address. When
other people are in the workspace it deletes only the caller, who leaves; the
last owner is refused until someone else is an owner. When the caller is alone
it deletes the tenant row, which cascades to every scan, snapshot (the graph is
those snapshots), conversation, connection and encrypted ExternalId — including
the tenant's own audit trail, which is the right answer to a deletion request.

It reports what it deleted, and it says plainly what it cannot do: Sightline
cannot delete the CloudFormation stack in a customer's AWS account. Only they
can, and until they do, the role it created still exists.

## Known limitations

- **Four moderate dev-only advisories, with no upstream fix.** `drizzle-kit`
  (latest, 0.31.11) still depends on the deprecated `@esbuild-kit/*` packages,
  which pin `esbuild ~0.18.20`. The advisory is that esbuild's **development
  server** will answer cross-origin requests; `drizzle-kit` never starts one —
  it is a CLI that generates migration SQL — so the vulnerable code path is not
  reached. An npm `overrides` entry does not help: the tilde pin means npm
  records the override and keeps 0.18.20 anyway. `npm audit --omit=dev` reports
  **zero** vulnerabilities, which is the number that describes what runs in
  production.
- **The policy analyser is not a complete IAM evaluator.** It models identity
  policies, explicit Deny, permissions boundaries and known escalation paths, but
  not service control policies, session policies or resource policies, so
  "effectively an administrator" is a strong hint rather than a formal proof.
- **One node, no replication, no SLA.** Postgres is a single replica; this is a single point of failure whose mitigation is a backup with a
  restore that has actually been tested, not a second replica that would make it
  worse. See [`deploy/k8s/README.md`](deploy/k8s/README.md).
- **A scan's peak memory is not bounded.** There is a ceiling on how many
  resources one scan may publish, which protects the graph. It does not protect
  the worker: the collectors have already held every resource in memory by the
  time it is checked, so an account large enough to exhaust the worker exhausts
  it before the limit fires. The worker runs in its own deployment so that it
  takes itself down rather than the API; the real fix is streaming collection.
- **Chat and scan quotas are per tenant and per hour**, which bounds cost but
  not a determined single request. The agent's own loop is capped at eight steps.
- **Backups do not leave the machine.** The nightly encrypted dump goes to a
  volume on the same node as the database, which survives a lost database and
  not a lost disk.
