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

Remediation commands are _generated as text for an operator to run_ and are
never executed by the product.

**The agent cannot write.** Its graph queries go through Neo4j's `executeRead`,
which routes them as read transactions — a write inside one fails at the
database rather than being filtered by a prompt. The agent has no shell, no
AWS client, and no tool that mutates anything.

## The ExternalId

It defeats the [confused-deputy problem](https://docs.aws.amazon.com/IAM/latest/UserGuide/confused-deputy.html):
knowing the role ARN is not enough to assume it, so one customer cannot be
tricked into letting another's deployment in. It is a credential. `npm run setup`
masks it in terminal output, never rotates one that is already in use, and the
`/api/connection/external-id` endpoint generates one without storing it.

## Known limitations

- **No authentication on the API.** It is designed to sit behind a reverse
  proxy: the `api` service publishes no host port at all and is reachable only
  through the `web` (nginx) container on the compose network. Publishing port
  3000 yourself would expose the whole graph to anyone who can reach it. This is
  documented rather than solved, and authentication is the first thing to build
  before any shared deployment.
- **Single-tenant.** One deployment reads one account. See
  [`docs/ROADMAP.md`](docs/ROADMAP.md) for what multi-tenancy would require.
- **Four moderate dev-only advisories, with no upstream fix.** `drizzle-kit`
  (latest, 0.31.11) still depends on the deprecated `@esbuild-kit/*` packages,
  which pin `esbuild ~0.18.20`. The advisory is that esbuild's **development
  server** will answer cross-origin requests; `drizzle-kit` never starts one —
  it is a CLI that generates migration SQL — so the vulnerable code path is not
  reached. An npm `overrides` entry does not help: the tilde pin means npm
  records the override and keeps 0.18.20 anyway. `npm audit --omit=dev` reports
  **zero** vulnerabilities, which is the number that describes what runs in
  production.
- **The policy analyser is not an IAM evaluator.** It does not model permission
  boundaries, service control policies, or session policies, so "effectively an
  administrator" is a strong hint rather than a formal proof.
