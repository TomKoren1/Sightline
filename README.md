# Sightline — AWS inventory, graph and agent

Sightline connects to an AWS account with a read-only role, ingests what is
there and how it fits together, and puts an agent on top that answers the
questions a DevOps engineer would act on — what can reach the production
database, who is effectively an administrator, what changed since yesterday.

It runs end to end against a mocked AWS account with no credentials and no
cloud spend.

```
AWS (real or mock) ──▶ scanner ──▶ Postgres ──▶ Neo4j ──▶ agent ──▶ React UI
                       assume-role  system of   graph     curated   graph +
                       per service  record      projection tools    chat
                       per region
```

---

## Try it

You need Docker. Nothing else — no AWS account, no credentials, no cloud spend, no
configuration.

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
[`docs/SETUP.md`](docs/SETUP.md) has the other way.

4. **Ask** _"What can reach the production database?"_ — it is private and not
   publicly accessible, and two chains reach it. Every answer cites the
   resources it used, and each citation is checked against what the tools returned.
5. **Ask a trick question:** _"analytics-db has PubliclyAccessible set to true — is
   it actually exposed?"_ The answer is no, because its security group opens no
   ports. A tool that read the flag would get this wrong.

[`docs/WALKTHROUGH.md`](docs/WALKTHROUGH.md) is the guided tour.

## Point it at your own AWS account

Optional. The mock account exercises the same code paths — the scanner does not know
it is talking to a mock.

```bash
npm run setup
```

One command, and it needs the AWS CLI. It works out which identity to trust, creates
a read-only IAM role with CloudFormation, wires this deployment up to it, restarts
the API and tells you whether the connection works. It shows the plan and asks before
anything changes; `npm run setup -- --dry-run` previews it all and changes nothing.

The role grants **SecurityAudit** and **ViewOnlyAccess** with an explicit **Deny** on
reading your data — no `s3:GetObject`, `secretsmanager:GetSecretValue`,
`dynamodb:GetItem`, `ssm:GetParameter` or `sqs:ReceiveMessage`. A Deny in IAM cannot
be overridden by any Allow, so that holds even if AWS widens one of those managed
policies later. `npm run setup -- --disconnect` deletes the role again.

Full detail, and how to do it by hand: [`docs/SETUP.md`](docs/SETUP.md).

## What is in the mock account

The brief asks for mock data whose questions have non-obvious answers, so the
account is built around traps that defeat a naive lookup:

|                                         |                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Two buckets, one policy**             | `northwind-public-assets` and `northwind-reports` carry byte-identical wildcard-principal policies. Only the first is public; the second is neutralised by `RestrictPublicBuckets`.                                                                                                                                                                                                                                                                                   |
| **Public vs unguarded**                 | Buckets with Block Public Access switched off are reported **separately** from public ones. Turning the block off grants nobody anything — it removes the guardrail that would neutralise a permissive policy, so an anonymous request still gets 403. Conflating the two is the most common misreading in this area ([ADR-012](docs/DECISIONS.md)).                                                                                                                  |
| **A private database anyone can reach** | `northwind-prod-db` is `PubliclyAccessible: false` in a private subnet, and is reachable from the internet by **two** chains — three hops through the web and app tiers, and two through a bastion with SSH open to the world.                                                                                                                                                                                                                                        |
| **A public database nobody can reach**  | `analytics-db` is `PubliclyAccessible: true` and its security group opens no ports. The obvious answer is wrong.                                                                                                                                                                                                                                                                                                                                                      |
| **Admin hiding in plain sight**         | Three roles and two users are effectively administrator. One role carries `AdministratorAccess`, one grants `*:*` **inline** under the name `LegacyDeployRole`, one is privileged but entirely unused, and one _user_ grants `*:*` inline under the name `BackupHelper`. Users are here because a real account exposed their absence: admin detection read roles only, so an account administered through IAM users reported no administrators (engineering log #29). |
| **Money going nowhere**                 | Unattached volumes, an unassociated elastic IP, a stopped instance, and a NAT gateway in an abandoned region — about $103/month.                                                                                                                                                                                                                                                                                                                                      |
| **Three regions**                       | Production in `us-east-1`, staging in `eu-west-1` with RDP open to the world, and `ap-southeast-1` nobody has looked at in two years.                                                                                                                                                                                                                                                                                                                                 |

The answer key lives in [`packages/mock-aws/src/topology.ts`](packages/mock-aws/src/topology.ts)
and is written by hand rather than generated from the code under test, so an
analyser bug cannot grade itself as correct.

---

## How it works

```
AWS ──▶ scanner ──▶ Postgres ──▶ Neo4j ──▶ agent ──▶ UI
        per service  immutable    graph     curated   graph +
        per region   snapshots    projection tools     chat
```

**Postgres is the system of record; Neo4j is a rebuildable projection of it.** The
questions are about relationships — _"what can reach the production database?"_ is a
variable-length path query, one `MATCH` in Cypher against a recursive CTE in SQL. But
scan history, per-region partial failures and agent traces all fit badly in a graph,
so they live in Postgres, and the graph is replayed from it without rescanning.

**Every security verdict is computed in code, never by the model.** Whether a bucket
is public, whether a role is effectively admin, what can reach what — all of it is
deterministic, and each verdict carries the evidence it was derived from. The model
chooses which question to ask and explains the answer; it does not decide the answer.

**The agent gets a curated tool library rather than free-form Cypher.** Sixteen tools,
fifteen of them queries written and reviewed in advance and one a guarded escape hatch
for questions nobody anticipated. After it answers, every identifier in its reply is
checked against what the tools actually returned, and anything unsupported is flagged
to the user — because a confident, plausible, invented resource id is the failure a
reader cannot catch themselves.

**It cannot change anything.** No tool can express a mutation and the IAM role holds
no write permissions. Asked to fix something, it says what it would run and why it
will not run it.

Two eval tiers back this up: **fifteen ground-truth checks** against a hand-written
answer key, needing no model and no API key, running in CI on every commit; and
**twenty-one cases** against the live agent, scored on the resources each answer
cites, with traps that a tool reading flags rather than evaluating them would fall
into. The same checks run inside the product, under **Trust**.

The reasoning behind each of these is in
[**docs/ASSIGNMENT.md**](docs/ASSIGNMENT.md) and the eighteen ADRs in
[**docs/DECISIONS.md**](docs/DECISIONS.md).

## Repository layout

```
apps/api            backend: scanner, analysers, graph, agent, HTTP API
  src/aws/          credentials, instrumented clients, region discovery
  src/scan/         collectors, analysers, orchestration
  src/db/           Drizzle schema and migrations, repository, Neo4j projection
  src/agent/        tools, Cypher guard, citation validation, the loop
  src/evals/        tier-1 ground truth, tier-2 cases and grading
  src/health/ graph/ scans/ chat/ connection/
                    one NestJS module each: a controller over a service
apps/web            React frontend: graph, chat, findings, UX states
packages/shared     domain model shared by every package
packages/mock-aws   the seeded customer account and its answer key
infra/              the replacement read-only role, and the original
deploy/             nginx config for the containerised frontend
Dockerfile          API and frontend images, used only by the `app` profile
docs/               decisions, engineering log, commit log, walkthrough
```

## Documentation

- **[docs/DECISIONS.md](docs/DECISIONS.md)** — eighteen ADRs: the stack, the
  mock, the two-database split, deterministic analysis, the tool boundary,
  citation validation, the IAM role, the eval strategy, the read-only refusal in
  code, guided onboarding, evals shown in the product, public vs unprotected,
  the runtime account toggle, remediation that is never applied, onboarding
  automated by a host script rather than a form, and the three that supersede
  earlier ones — Drizzle, NestJS, and the agent loop moving onto the Vercel AI
  SDK, each recording what the decision it replaces got right as well as wrong.
- **[docs/ENGINEERING-LOG.md](docs/ENGINEERING-LOG.md)** — every non-obvious
  problem hit while building this, with diagnosis and fix. Includes a silent
  moto account-namespacing trap, two capability gaps in the mock recorded as
  gaps rather than hidden, and an SDK type that degraded to `any` behind
  `skipLibCheck`.
- **[docs/ASSIGNMENT.md](docs/ASSIGNMENT.md)** — the engineering write-up: what the
  brief asked for and where each piece lives, the storage model, how the agent
  works, how I know the answers are right, what breaks first at scale, and what I
  would build next.
- **[docs/SETUP.md](docs/SETUP.md)** — configuration, the host development path,
  connecting AWS by hand, troubleshooting and every command. Nothing in it is
  needed to run the project.
- **[docs/COMMITS.md](docs/COMMITS.md)** — what each commit changed and why.
- **[docs/WALKTHROUGH.md](docs/WALKTHROUGH.md)** — a guided tour of the running
  system.
- **[docs/handover/](docs/handover/)** — two print documents: a project handover
  (decisions, problems, limits) and a **codebase tour** that walks every source
  file, traces the four request paths hop by hop with line numbers, and indexes
  likely questions to the file that answers them.
