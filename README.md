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
[How it works](#how-it-works) · [Layout](#repository-layout) ·
[Working on the code](#working-on-the-code) ·
[A real AWS account](#connecting-a-real-aws-account) ·
[Troubleshooting](#troubleshooting) · [Commands](#every-command) ·
[Limits](#limits-and-what-is-next)

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

1. **Run the first scan.** 101 resources across three regions in about two seconds.
2. **Change the account and rescan** — `npm run drift && npm run scan` — then open
   **Changes**. Two buckets get the same permissive policy and only one becomes
   public, because the other's access block neutralises it. Verdicts are computed,
   not read off a field.
3. **Open Trust.** What is checked, when it last ran, and the last agent eval.

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

| Question                                    | Why it is not a lookup                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **What can reach the production database?** | It is in a private subnet and not publicly accessible, yet the internet reaches it across three security-group hops, by a shorter path through a bastion, through a load balancer that forwards to the app tier, through CloudFront in front of that load balancer, and through an API that invokes a Lambda. Answering means walking a graph, not reading a flag.                                                                                                                                                      |
| **Is it really exposed?**                   | An internal load balancer whose security group admits `0.0.0.0/0` is not reachable from the internet, and a host with SSH open to the world in a public subnet is not either when its subnet's network ACL denies port 22. Security groups alone get both wrong.                                                                                                                                                                                                                                                        |
| **Can the other VPC get in?**               | A rule admitting `10.1.0.0/16` is a path only when routes join the two VPCs both ways — over a peering, or through a transit gateway whose own route table carries it. The mock's partner VPC is admitted by the database's group and peered, and still cannot reach it: prod has no route back. A subnet with no route table of its own is judged by its VPC's main one, which AWS applies silently.                                                                                                                   |
| **Is this bucket public?**                  | Four inputs interact: the bucket policy, its ACL, its public access block, and the account's. Two buckets carry byte-identical permissive policies and exactly one is public, because the other's access block neutralises it.                                                                                                                                                                                                                                                                                          |
| **Open by policy, not by network**          | A queue anyone can send to and a secret anyone can read are public through their resource policies alone, with no network path involved. SNS's default topic policy grants `{"AWS": "*"}` too, and is not public, because it is conditioned on the topic's owner.                                                                                                                                                                                                                                                       |
| **Public vs unguarded**                     | Buckets with Block Public Access switched off are reported **separately** from public ones. Turning the block off grants nobody anything — it removes the guardrail that would neutralise a permissive policy, so an anonymous request still gets 403. Conflating the two is the most common misreading in this area.                                                                                                                                                                                                   |
| **Who is effectively an administrator?**    | Five roles and three users. One role carries `AdministratorAccess`, one grants `*:*` **inline** under the name `LegacyDeployRole`, one is privileged but entirely unused, one holds no `*` at all but can **escalate** through `iam:PassRole` and Lambda, and one is admin through a `NotAction` that leaves IAM writable; one _user_ grants `*:*` inline as `BackupHelper`, and one holds no policy at all and is admin through its **group**. Finding them means reading policy documents and memberships, not names. |
| **Money going nowhere**                     | Unattached volumes, an unassociated elastic IP, a stopped instance, and a NAT gateway in an abandoned region — about $103/month.                                                                                                                                                                                                                                                                                                                                                                                        |

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

**The agent gets a curated tool library rather than free-form SQL.** Seventeen tools,
sixteen of them queries written and reviewed in advance and one a guarded escape hatch
for questions nobody anticipated: a single parsed `SELECT` over two views pinned to one
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
[`infra/readonly-role.yaml`](infra/readonly-role.yaml) uses `SecurityAudit` plus
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
same checks run inside the product, under **Trust**.

---

## Repository layout

```
apps/api              backend: scanner, analysers, graph, agent, HTTP API
  src/config.ts       every setting, with the reason for each default
  src/hostedMode.ts   configuration the public service refuses to start with
  src/aws/            credentials, instrumented clients, region discovery
  src/scan/           collectors, analysers, orchestration; collectors/README.md lists each
  src/db/             Drizzle schema and migrations, repository, the graph queries
  src/agent/          tools, SQL guard, citation validation, the loop
  src/auth/           OIDC against Google and GitHub, sessions, route guard
  src/tenancy/        tenants, connections, onboarding, limits, branded ids
  src/jobs/           the Postgres queue, the worker, scan progress
  src/observability/  structured logs, and what they redact
  src/remediation/    generated fix commands, never executed
  src/setup/          what `npm run setup` plans and does
  src/evals/          tier-1 ground truth, tier-2 cases and grading
  src/health/ graph/ scans/ chat/ connection/
                      one NestJS module each: a controller over a service
apps/web              React frontend: graph, chat, findings, UX states
  src/api.ts          the only place that calls the API, so headers cannot be missed
packages/shared       domain model shared by every package
packages/mock-aws     the seeded customer account and its answer key
infra/                the read-only role template, and guards on things nothing runs
deploy/k8s/           kustomize manifests for a hosted deployment, and their README
deploy/               nginx config, and the AWS profile mount for containers
helm/monitoring/      Prometheus, Grafana and Loki, with this project's dashboards
argocd/               the Application that deploys that chart
scripts/              the dependency guard every npm script runs first
e2e/                  the browser suite: the hosted product, signed in and driven
Dockerfile            API and frontend images, used only by the `app` profile
```

Two deployment tools, and the boundary is deliberate: **kustomize deploys the
application, Helm deploys the platform.** The monitoring stack is three upstream
community charts with pinned versions and hundreds of values, which is Helm's
natural unit; re-expressing it in kustomize would mean vendoring rendered output.

`infra/` deserves a word: it holds tests over artefacts **no test executes** — the
CloudFormation template, the Kubernetes manifests, the Dockerfile, the legal pages.
Each guards an agreement between two files that nothing else connects, which is the
defect class this repository keeps meeting.

---

## Working on the code

Docker for the three dependencies, Node for the rest — hot reload, and the CLIs to
hand.

```bash
docker compose up -d          # Postgres and moto (mock AWS)
npm install

npm run seed                  # build the fictional customer account
npm run scan                  # discover it, persist it, build the graph

npm run dev:api               # http://localhost:3000
npm run dev:web               # http://localhost:5173   ← open this
```

Scans run on a Postgres-backed queue. The API process drains it itself, so this is
all you need — closing the tab no longer orphans a scan, and reloading mid-scan
rejoins it. To run scans in their own process as a hosted deployment does, set
`SCAN_WORKER=separate` and also run `npm run dev:worker`.

Both paths are covered by CI, and nothing about the product differs between them.

The browser suite drives the **hosted** product the way a customer does — sign in,
scan, read the findings, ask, start connecting an account — with GitHub and the model
stood in for on loopback. With the compose stack up and seeded:

```bash
npx playwright install chromium   # once
npm run e2e                       # starts its own API, worker and frontend
```

Run `npm run verify` before pushing — it is everything CI's static job runs.

For a hosted deployment on Kubernetes — kustomize manifests, a Cloudflare tunnel,
sealed secrets, and an encrypted backup with a restore procedure that is tested
rather than described — see [`deploy/k8s/README.md`](deploy/k8s/README.md).

**Releases** are a version tag: `git tag v0.2.0 && git push origin v0.2.0` builds the
API and web images once, fails on a critical or high vulnerability with a fix
available, and pushes them to `ghcr.io/<owner>/sightline-api` and `-web` with an SBOM,
build provenance and a keyless cosign signature. The run's summary gives each digest
and the `cosign verify` command; deploy by digest.

What a hosted deployment holds, shares and deletes is in
[`PRIVACY.md`](PRIVACY.md); the terms are in [`TERMS.md`](TERMS.md); and the
security properties, including how one customer's data is kept from another's,
are in [`SECURITY.md`](SECURITY.md).

### House style

Four things, because they are the ones that have actually gone wrong here:

- **Comments carry the non-obvious _why_, and nothing else.** The bug a line
  prevents, the alternative that was rejected, the AWS behaviour that is not in the
  docs. Not a restatement of the code, not a second example, not build-up. Roughly
  ten lines is the ceiling for a genuinely subtle module header; most want two.
  `infra/commentBudget.test.ts` measures it, because this has drifted twice.
- **A guard for every agreement between two files.** If editing one file can
  silently invalidate another — a manifest and the code that reads it, a template
  and the ARN derived from it — the test goes in `infra/`. Write it so that
  _forgetting_ trips it, and break it once to watch it go red.
- **Derive, don't enumerate.** Lists in code go stale: the leak test enumerates
  queries by reflection, the purge enumerates tenant-scoped tables from the schema,
  and the graph sweep derives what to keep from the database. Each of those caught a
  real bug that a hand-written list would have missed.
- **Refuse rather than guess.** Ambiguous configuration, a mistyped id, an
  unparseable limit — fail loudly at the edge. Every silent fallback in this
  repository's history produced a working system with a quietly wrong answer.

The agent uses Anthropic. `ANTHROPIC_MODEL` defaults to `claude-sonnet-5`.
`/api/health` says whether a key is configured rather than making you discover it
through a failed request, and names the `.env` it read if the key is missing.

---

## Connecting a real AWS account

Entirely optional — the mock exercises the same code paths, and the scanner does not
know it is talking to a mock. `npm run setup` does the whole thing: it shows what it
will do and asks before anything changes, backs `.env` up first, and rewrites **only**
the keys it names — verified against its own output rather than promised. It never
asks for an access key and cannot write one. Re-running is a no-op, and it reuses an
ExternalId already in use rather than rotating a working secret.

|                                   |                                                 |
| --------------------------------- | ----------------------------------------------- |
| `npm run setup -- --dry-run`      | print the plan, change nothing                  |
| `npm run setup -- --mock`         | stay on the demo account                        |
| `npm run setup -- --disconnect`   | delete the role and go back to the demo account |
| `npm run setup -- --profile work` | use a named AWS CLI profile                     |

**A whole AWS Organization** connects once, in the hosted product: choose
_An AWS Organization_ when connecting, deploy the stack in the management account
(or a delegated administrator for Organizations), and run the StackSet the screen
gives you to put the same role in every member account, including ones added later.
Checking the organization lists its accounts with `organizations:ListAccounts` and
makes each active one an account of its own under it: scanned, pinned and isolated
like one connected by hand. Accounts that leave are marked disconnected. Paths
_between_ accounts are not modelled yet.
| `npm run setup -- --yes` | no confirmations, for scripting |

It needs the AWS CLI, which is also what creates the role. The demo account needs
neither it nor Node.

The UI's **Connection** panel walks through the same thing by hand, and the **account
switcher** in the header moves between accounts at runtime without restarting or
rewriting `.env` — a clone has two, the demo fixture and whatever `.env` points at.
Switching does not rescan, so the graph keeps showing the previous account until you run
one, and the banner says so rather than letting you read one account's inventory under
another's name.

It replaced a demo/real toggle that flipped a module-level variable. That was honest for
one operator and would have been a shared surprise for many: one person clicking it
would have changed which AWS account every other tenant on the process was looking at.
The switcher sends a header instead, and the server validates that the connection is
yours.

By hand: deploy [`infra/readonly-role.yaml`](infra/readonly-role.yaml) and set

```bash
AWS_MODE=real                 # drops the endpoint override
AWS_TARGET_ROLE_ARN=arn:aws:iam::<customer>:role/SightlineReadOnlyRole
AWS_EXTERNAL_ID=<the per-customer secret>
AWS_SCAN_REGIONS=             # empty = discover every enabled region
```

In `real` mode the source credentials come from the standard AWS chain. Assume-role,
pagination, adaptive retry, region fan-out and partial-failure handling are the same
code in both modes.

### Three things that are easy to get wrong

Each of these cost a real deployment.

- **Two ARNs are involved and each looks like a valid value for the other.**
  `SightlineScannerRoleArn` is an _input_ — the principal allowed to assume.
  `AWS_TARGET_ROLE_ARN` is the stack's `RoleArn` _output_ — the role that gets
  assumed. `sts:AssumeRole` can only assume a role, so a user ARN in the second can
  never work; the API refuses it by name at startup rather than failing later with
  `AccessDenied`.
- **`aws sts get-caller-identity` does not print a principal ARN.** It reports your
  _session_, so it returns `arn:aws:sts::…`. A trust policy needs the
  `arn:aws:iam::…` identity behind it. The guide converts it; pasting the raw value
  fails the template's own parameter pattern.
- **The role must be deployed from the current template.** Every `AssumeRole` sends
  `sts:SourceIdentity` and the trust policy requires it. A role deployed from an
  older copy matches a pattern no legal value can satisfy — AWS forbids a colon in a
  SourceIdentity — so the assume is refused with `AccessDenied`.

### Getting credentials into the container

The scanner uses the standard AWS credential chain, which finds `~/.aws` on a host. A
container has no such directory unless it is given one, so a profile that works
locally fails inside the container with _"No source credentials were found"_.
Uncomment these in `.env`:

```bash
COMPOSE_PATH_SEPARATOR=:
COMPOSE_FILE=docker-compose.yml:deploy/compose.aws-profile.yml
```

The separator line is for Windows, where Compose splits `COMPOSE_FILE` on `;` and
otherwise fails with _"The filename, directory name, or volume label syntax is
incorrect"_. It is harmless elsewhere.

That mounts `~/.aws` read-only, and — the reason it belongs in `.env` rather than as
`-f` flags on the command line — it applies to **every** subsequent
`docker compose` command automatically. With flags, recreating the API to pick up an
edited `.env` drops the mount without saying so, and the next connection test reports
missing credentials for a setup that was working a moment earlier.

**On Windows there is nothing more to set.** PowerShell does not set `HOME`, so the
mount falls back to `USERPROFILE`; Git Bash and WSL set `HOME`. Avoid putting a
`C:/...` path in `AWS_PROFILE_DIR` if you ever run Compose from WSL — the Linux CLI
cannot parse it and the API fails to start with _"invalid volume specification"_.

It lands at `/home/node/.aws`, because the API container runs as the non-root `node`
user and that is where the SDK resolves `~` to. If the connection test still reports
missing credentials with those two lines already set, the mount is arriving somewhere
else — the message names the path it actually read, and
`docker exec sightline-api ls -l ~/.aws` confirms it.

The mount is preferable to real keys in `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`:
it keeps long-lived credentials out of a file sitting next to the code, and it carries
the SSO token cache, so `aws sso login` on the host works inside the container too.

---

## Troubleshooting

**A `.env` edit appears to do nothing.** Configuration is read once at startup, so the
process has to be **replaced**, not restarted:

```bash
docker compose --profile app up -d api     # recreates it with the new values
```

`docker compose restart api` is the command you would reach for and it does **not**
work: it restarts the existing container, whose environment was resolved when the
container was created, so the edit is ignored and the command exits zero. On the host
path, stop `npm run dev:api` and start it again — `tsx watch` does not watch `.env`.

**A container fails to start.** Ports in use. It binds `8080` for the app and `5432`
and `5000` for Postgres and moto; each is configurable in `.env` as `APP_PORT`,
`POSTGRES_PORT` and `MOCK_AWS_PORT`.
Running two clones at once will collide.

**A scan finds nothing.** moto holds the account in memory, so any `down` empties it.
Run `npm run seed` before `npm run scan`.

**Tearing it down:**

```bash
docker compose --profile app down -v     # use this one, whichever way you started it
```

The `--profile app` flag is **required to clean up if you ever started that profile**,
and harmless if you did not. Without it, Compose removes only the default services, so
the API and nginx containers are left running against databases that no longer exist.
`-v` deletes the volumes: every scan, the graph, agent traces and recorded eval runs.

---

## Every command

| Command                                        | What it does                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------ |
| `docker compose up -d`                         | Postgres and moto — just the dependencies                                      |
| `docker compose --profile app up -d --build`   | The whole thing in Docker, served on `:8080`                                   |
| `docker compose --profile app down -v`         | Tear it all down, volumes included                                             |
| `npm run setup`                                | Connect an AWS account, or switch back to the demo one                         |
| `npm run seed`                                 | Rebuild the mock account from scratch                                          |
| `npm run scan`                                 | Scan, persist, project the graph                                               |
| `npm run drift`                                | Change the mock account, so a second scan has a diff                           |
| `npm run inspect -w @sightline/api`            | Scan and print findings without touching the databases                         |
| `npm run query -w @sightline/api`              | Run every curated query against the graph                                      |
| `npm run dev:worker`                           | Run scans in their own process, as a hosted deployment does                    |
| `npm test`                                     | 754 unit tests — integration ones skip without databases                       |
| `npm run e2e`                                  | The browser suite, against the compose stack                                   |
| `npm run lint`                                 | Prettier and ESLint, both in check mode                                        |
| `npm run format`                               | Fix everything those two can fix automatically                                 |
| `npm run typecheck`                            | `tsc` over every workspace, and over `infra/` and `scripts/`                   |
| `npm run verify`                               | Everything CI's static job runs — use before pushing                           |
| `npm run evals:ground-truth -w @sightline/api` | Tier-1 evals — no API key needed                                               |
| `npm run evals -w @sightline/api`              | Tier-2 agent evals — needs a key                                               |
| `npm run gen:collectors -w @sightline/api`     | Regenerate the role template's grants and the collector list from the registry |
| `npm run db:app-role -w @sightline/api`        | Set the restricted role's password, for row-level security                     |
| `./scripts/backup-restore-test.sh`             | Back up, restore, and check an ExternalId still decrypts                       |
| `helm template monitoring helm/monitoring`     | Render the monitoring stack without deploying it                               |
| `npm run db:generate -w @sightline/api`        | Generate a migration after editing `src/db/schema.ts`                          |
| `npm run db:migrate -w @sightline/api`         | Apply pending migrations — a clone also does this on boot                      |
| `npm run db:studio -w @sightline/api`          | Browse the database in Drizzle Studio                                          |

---

## Limits and what is next

Every limit here is one I can point at in the code, and every fix is one the design
already leaves room for.

**What breaks first on a large account,** in the order it would happen:

1. **The graph rebuild, at roughly 50k resources.** A scan projects into its own scope
   and `scan_runs.projected_at` makes it current, so commits are batched and heap use is
   flat — but it is still O(all resources) per scan, and the superseded scope has to be
   swept afterwards. _Fix:_ diff the Postgres snapshots, which already exist, and `MERGE`
   only what changed.
2. **Scan wall-clock across many regions.** 6 services × 30 regions is 180 units at a
   concurrency of 6, and per-bucket S3 calls are four each. Partly addressed by the
   Resource Explorer fast path, which asks one indexed query which regions hold
   anything and skips the rest. _Remaining fix:_ per-service concurrency and splitting
   oversized units.
3. **Throttling, well before that.** `retryMode: adaptive` handles bursts, but a full
   parallel scan of a busy account will hit quotas and compete with the customer's own
   workloads. _Fix:_ a token bucket per `(service, region)` sized from published
   quotas, and a scan budget the customer controls.
4. **The frontend, at about 2,000 nodes.** React Flow renders every node. _Fix:_
   server-side aggregation — collapse a VPC to one node until expanded — and viewport
   virtualisation.
5. **The agent's context, on broad questions.** Tool results are capped and truncated.
   _Fix:_ tools should return aggregates with drill-down, and say so when truncating.

**What does not break:** partial-failure handling and credential renewal both get
_more_ useful at scale, which is why they were built in from the start.

**Multi-tenancy** is built, as far as the data path goes. Every table holding customer
data carries a tenant id — `NOT NULL`, with no default, so an insert that forgets one
fails rather than landing in somebody else's account. A resource's identity is
`(scanId, arn)` rather than `arn`, because two tenants collide immediately on the
synthetic `Internet` node and completely if they connect the same AWS account. Every
graph read runs under row-level security and names its scan, and
[`tenantIsolation.test.ts`](apps/api/src/db/tenantIsolation.test.ts) loads two
tenants side by side and asserts that no query returns the other's data — discovering
the query list by reflection, so a new query fails for _not being covered_ before it can
fail for leaking. Credentials are cached per connection rather than per process, and the
AWS target comes from a `connections` row with no fallback to configuration.

**Sign-in** is Google and GitHub, written against the protocol rather than through a
library, with sessions as rows so one can actually be revoked. Matching is on the
provider's subject and never on an email address, and the same address arriving from a
second provider is refused rather than silently joined to the first account. Every route
is protected by one global guard and escapes only by saying `@Public()`;
[`enforcement.test.ts`](apps/api/src/auth/enforcement.test.ts) takes the real route table
from Fastify and checks both directions, so a route added later cannot quietly answer an
unauthenticated request.

`DEPLOYMENT_MODE=hosted` refuses to start on configuration that would produce a working
system with a silently wrong security property, and names every problem at once rather
than one per restart. The capabilities that are harmless with one operator and dangerous
with many are **removed** there rather than guarded: no process-wide endpoint override,
no process-wide mock, and no raw-SQL escape hatch for the agent — defence in depth on
top of the row-level security its reads already run under.

**Connecting an account** is one link and one field. A quick-create CloudFormation link
arrives with the ExternalId and the trusted principal already filled in, the customer
ticks the IAM acknowledgement and presses Create stack, and types their twelve-digit
account id — the role's name is fixed by the template, so Sightline derives the ARN
rather than asking anyone to paste one. The screen then polls `sts:AssumeRole` and goes
green on its own, usually while they are still looking at CloudFormation.

Two things it deliberately does not do. The stack creates **one IAM role and calls
nobody**: a Lambda-backed custom resource could report the ARN back and remove the twelve
digits entirely, and that would put a function, an execution role and an outbound call to
a third party into a stack a security reviewer has to approve. And the ExternalId stays
**readable** to whoever owns the connection rather than being shown once — it grants
nothing without Sightline's own credentials, their deployed stack holds it in plaintext in
the trust policy anyway, and hiding it makes a failed deploy unrecoverable without
rotating a secret the stack already contains. The AWS CLI and Terraform forms sit behind
the same link, because a console link is useless to anyone whose organisation forbids it.

When it does not work, the diagnosis is the product. `AccessDenied` becomes "the trust
policy does not name this principal — it names _this_ one, redeploy with that value, and
here is the command to check", which is the difference between ten minutes and an
afternoon.

What is still single-process: the scan runs inside the API rather than on a worker behind
a queue, so a long scan is tied to the request that started it. That is the next piece,
along with the per-tenant limits that a public deployment needs before it meets anyone.

**What I would build next:** incremental graph updates (removes the first limit and
makes scans cheap enough to run continuously); real idle detection from CloudWatch and
Cost Explorer, for which the role already grants the permissions; an LLM judge over a
larger eval set; scheduled scans, so _"what changed overnight?"_ is answerable without
someone having remembered to scan; and more of the account — ELB especially, which
would fill a real gap in the reachability graph.

---

## Security

Read-only by construction, no long-lived credentials, and an agent that cannot write.
The details, the ExternalId's purpose, and the known limitations are in
[SECURITY.md](SECURITY.md). Licensed under [MIT](LICENSE).
