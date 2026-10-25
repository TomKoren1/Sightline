# Sightline — AWS inventory, graph and agent

[![CI](https://github.com/TomKoren1/Sightline/actions/workflows/ci.yml/badge.svg)](https://github.com/TomKoren1/Sightline/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Sightline connects to an AWS account with a read-only role, ingests what is there
and how it fits together, and puts an agent on top that answers the questions a
DevOps engineer would act on — what can reach the production database, who is
effectively an administrator, what changed since yesterday.

It runs end to end against a mocked AWS account with no credentials and no cloud
spend.

```
AWS (real or mock) ──▶ scanner ──▶ analysers ──▶ Postgres ──▶ agent ──▶ React UI
                       assume-role  verdicts in   inventory,   curated   graph +
                       per service  code, with    graph and    tools     chat
                       per region   evidence      history

                       a scan is a queued job; Postgres is the queue, and
                       every row above is scoped to one tenant's connection
```

**Contents** — [Try it](#try-it) · [What it answers](#what-it-answers) ·
[How it works](#how-it-works) · [Deploying](#deploying) ·
[Layout](#repository-layout) · [Documentation](#documentation)

---

## Try it

You need Docker. Nothing else — no AWS account, no credentials, no configuration.

```bash
docker compose --profile app up -d --build
```

Then open **<http://localhost:8080>**.

The first run builds two images and takes a couple of minutes. It starts the
databases and a mock AWS account, seeds a fictional customer, and serves the app.
You arrive at an empty graph with a prompt to run the first scan — press it, and
watch the scan stream service by service.

**Three things worth doing straight away**, none of which need anything else:

1. **Run the first scan.** Nearly two hundred resources across three regions, in
   seconds.
2. **Change the account and rescan** — `npm run drift && npm run scan` — then open
   **Changes**. Two buckets get the same permissive policy and only one becomes
   public, because the other's access block neutralises it. Verdicts are computed,
   not read off a field.
3. **Open Coverage.** What the last scan could see, the data checks against the demo
   account's answer key, and the last agent eval.

**Then add an Anthropic key to talk to it:**

```bash
npm run setup -- --anthropic-key sk-ant-...
```

That writes it and restarts the API. If you would rather not install Node for it,
put `ANTHROPIC_API_KEY=sk-ant-...` in `.env` and recreate the API container with
`docker compose --profile app up -d api`.

4. **Ask** _"What can reach the production database?"_ — it is private and not
   publicly accessible, and two chains reach it. Every answer cites the resources
   it used, and each citation is checked against what the tools returned.
5. **Ask a trick question:** _"analytics-db has PubliclyAccessible set to true — is
   it actually exposed?"_ The answer is no, because its security group opens no
   ports. A tool that read the flag would get this wrong.

Chat needs the key. The scan, the graph, the findings sidebar and the whole
tier-1 eval suite do not.

---

## What it answers

Each of these needs reasoning rather than a field lookup, which is the point of
the mock account's shape.

**What can reach the production database?** It is in a private subnet and not
publicly accessible, yet the internet reaches it across three security-group hops,
by a shorter path through a bastion, through a load balancer that forwards to the
app tier, through CloudFront in front of that load balancer, and through an API that
invokes a Lambda. Answering means walking a graph, not reading a flag.

**Is it really exposed?** An internal load balancer whose security group admits
`0.0.0.0/0` is not reachable from the internet, and a host with SSH open to the
world in a public subnet is not either when its subnet's network ACL denies port 22.
Security groups alone get both wrong.

**Can the other VPC get in?** A rule admitting `10.1.0.0/16` is a path only when
routes join the two VPCs both ways — over a peering, or through a transit gateway
whose own route table carries it. The mock's partner VPC is admitted by the
database's group and peered, and still cannot reach it: prod has no route back. A
subnet with no route table of its own is judged by its VPC's main one, which AWS
applies silently.

**Is this bucket public?** Four inputs interact: the bucket policy, its ACL, its
public access block, and the account's. Two buckets carry byte-identical permissive
policies and exactly one is public, because the other's access block neutralises it.

**Open by policy, not by network.** A queue anyone can send to and a secret anyone
can read are public through their resource policies alone, with no network path
involved. SNS's default topic policy grants `{"AWS": "*"}` too, and is not public,
because it is conditioned on the topic's owner.

**Public vs unguarded.** Buckets with Block Public Access switched off are reported
**separately** from public ones. Turning the block off grants nobody anything — it
removes the guardrail that would neutralise a permissive policy, so an anonymous
request still gets 403. Conflating the two is the most common misreading in this
area.

**Who is effectively an administrator?** Five roles and three users. One role
carries `AdministratorAccess`, one grants `*:*` **inline** under the name
`LegacyDeployRole`, one is privileged but entirely unused, one holds no `*` at all
but can **escalate** through `iam:PassRole` and Lambda, and one is admin through a
`NotAction` that leaves IAM writable; one _user_ grants `*:*` inline as
`BackupHelper`, and one holds no policy at all and is admin through its **group**.
Finding them means reading policy documents and memberships, not names.

**Money going nowhere.** Unattached volumes, an unassociated elastic IP, a stopped
instance, and a NAT gateway in an abandoned region — about $103/month.

The answer key lives in
[`packages/mock-aws/src/topology.ts`](packages/mock-aws/src/topology.ts) and is
written by hand rather than generated from the code under test, so an analyser bug
cannot grade itself as correct.

---

## How it works

**One database.** Each scan's resources and relationships are rows in Postgres, and
that is the graph: lookups and findings are SQL over computed verdicts, and the path
questions — _"what can reach the production database?"_ — load the scan's
`CAN_REACH` edges and search them in memory, bounded by hop count. A separate graph
database was tried and removed: it doubled the stores to back up, isolate and keep in
step for two queries that a breadth-first search answers in milliseconds.

**Every security verdict is computed in code, never by the model.** Whether a bucket
is public, whether a role is effectively admin, what can reach what — all of it is
deterministic, and each verdict carries the evidence it was derived from. The model
chooses which question to ask and explains the answer; it does not decide the answer.

**The agent gets a curated tool library rather than free-form SQL.** Eighteen tools,
seventeen of them queries written and reviewed in advance and one a guarded escape hatch
for questions nobody anticipated: a single parsed `SELECT` over three views pinned to one
scan, run read-only, on a timeout, under the tenant's row-level security. After it answers, every identifier in its reply is
checked against what the tools actually returned, and anything unsupported is flagged
to the user — because a confident, plausible, invented resource id is the failure a
reader cannot catch themselves.

**It says what it is doing, and the metrics carry no customer in them.** Logs are
structured and redact an ExternalId by field name at every nesting depth; metrics are
served on their own port, which nginx does not proxy, so they are unreachable from the
internet by construction rather than by a rule. No metric may be labelled with a tenant,
connection, user, ARN or account id — Prometheus has no tenant isolation, so a tenant
label would put customer identity outside everything that design covers, and multiply
every series by the customer count. A test enumerates the registry and refuses one.
See [`helm/monitoring/README.md`](helm/monitoring/README.md).

**It cannot change anything.** No tool can express a mutation and the IAM role holds
no write permissions. Asked to fix something, it says what it would run and why it
will not run it. Remediation is generated as text for an operator to run, and every
one states what it might break.

**The role refuses `ReadOnlyAccess`.** That policy grants roughly 7,000 actions
including data-plane reads — `s3:GetObject`, `secretsmanager:GetSecretValue`,
`sqs:ReceiveMessage` — which an inventory product has no business holding.
[`cloudformation/readonly-role.yaml`](cloudformation/readonly-role.yaml) uses `SecurityAudit` plus
`job-function/ViewOnlyAccess`, an enumerated inline policy for the handful of calls
those miss, and an explicit **Deny** on data-plane reads that is attached by default.
A Deny cannot be overridden by any Allow, including one a future AWS update might add
to a managed policy. See [SECURITY.md](SECURITY.md).

**One deployment serves many tenants, and the database refuses to mix them.**
Every tenant-scoped table has row-level security, and the application connects as a
restricted role the policies apply to — not the table owner, which would bypass them.
Every graph query also names its scan, so a scan id from the wrong tenant is refused
twice over. A two-tenant leak test enumerates the query layer
**by reflection**, so a query added later fails for not being covered before it can
fail for leaking. See [SECURITY.md](SECURITY.md).

### How the answers are checked

Two eval tiers that fail for different reasons: **twenty-nine ground-truth checks**
against the hand-written answer key, needing no model and no API key, running in CI
on every commit; and **twenty-one cases** against the live agent, scored on the
resources each answer cites, with traps that a tool reading flags rather than
evaluating them would fall into. The split makes failures diagnosable — tier 1
passing and tier 2 failing means the data is right and the agent misused it. The
same checks run inside the product, under **Coverage**, for the demo account.

---

## Deploying

The hosted deployment is one Kubernetes node, reconciled from this repository.
Every commit on `main` that passes CI becomes two images on ghcr.io — scanned
for known vulnerabilities, signed, with an SBOM — and a commit pinning the prod
overlay to their digests. ArgoCD sees the pin, runs the database migrations as
a PreSync hook, and rolls the pods only once they have finished; a pod that
starts against an older schema refuses to run rather than serving from it.
Secrets live in the repository too, sealed to the cluster's own key.

[`deploy/k8s/README.md`](deploy/k8s/README.md) covers the cluster: the manifests,
the tunnel, sealing secrets, and backups with a restore that is tested rather
than described. Two deployment tools, and the boundary is deliberate:
**kustomize deploys the application, Helm deploys the platform** — Prometheus,
Grafana and Loki, three upstream charts with pinned versions
([`helm/monitoring/`](helm/monitoring/README.md)).

---

## Repository layout

```
apps/api              backend: scanner, analysers, graph, agent, HTTP API
  src/core/           what everything builds on, importing nothing else in src:
                      settings, the hosted-mode refusals, ids, scope, paths
  src/aws/            credentials, instrumented clients, pacing, region discovery
  src/scan/           collectors, analysers, orchestration; collectors/README.md lists each
  src/db/             Drizzle schema and migrations, repository, the graph queries
  src/agent/          tools, SQL guard, citation validation, the loop
  src/auth/           OIDC against Google and GitHub, sessions, teams, API tokens
  src/tenancy/        tenants, connections, onboarding, limits, secrets
  src/jobs/           the Postgres queue, the worker's jobs, scan progress
  src/remediation/    generated fix commands, never executed
  src/evals/          tier-1 ground truth, tier-2 cases and grading
  src/http/           the NestJS edge: one folder per area, a controller over a service
  src/server.ts       the API process; src/worker.ts runs scans without an HTTP server
  test/load/          the 50,000-resource load test and the estate it replicates
apps/web              React frontend; src/api.ts is the only place that calls the API
packages/shared       domain model shared by every package
packages/mock-aws     the seeded customer account and its hand-written answer key
cloudformation/       the read-only role customers deploy
guards/               tests that hold two files to each other, over things nothing runs
deploy/               kustomize manifests (k8s/), nginx, the AWS profile mount for compose
helm/monitoring/      Prometheus, Grafana and Loki, with this project's dashboards
argocd/               the ArgoCD Applications for the monitoring chart and each overlay
e2e/                  the browser suite: the hosted product, signed in and driven
scripts/              image pinning, secret sealing, backup checks, the dependency guard
docs/                 development, AWS accounts, the roadmap, ADRs, the OpenAPI description
```

`guards/` deserves a word: it holds tests over artefacts **no test executes** — the
CloudFormation template, the Kubernetes manifests, the Dockerfile, the legal pages.
Each guards an agreement between two files that nothing else connects, which is the
defect class this repository keeps meeting.

---

## Documentation

| Document                                                 | For                                                              |
| -------------------------------------------------------- | ---------------------------------------------------------------- |
| [`docs/development.md`](docs/development.md)             | running from source, house style, every command, troubleshooting |
| [`docs/aws-account.md`](docs/aws-account.md)             | connecting a real account or an Organization, and the traps      |
| [`docs/roadmap.md`](docs/roadmap.md)                     | what breaks first at scale, and what is not built yet            |
| [`docs/adr/`](docs/adr/README.md)                        | decisions the code depends on, with the reason for each          |
| [`docs/openapi.json`](docs/openapi.json)                 | every route, generated from the contract the tests enforce       |
| [`deploy/k8s/README.md`](deploy/k8s/README.md)           | the hosted deployment: cluster, secrets, backups, restore        |
| [`helm/monitoring/README.md`](helm/monitoring/README.md) | the monitoring stack and what its metrics may carry              |
| [`SECURITY.md`](SECURITY.md)                             | the security properties, tenant isolation, known limitations     |
| [`PRIVACY.md`](PRIVACY.md) · [`TERMS.md`](TERMS.md)      | what a hosted deployment holds, shares and deletes; the terms    |

Licensed under [MIT](LICENSE).
