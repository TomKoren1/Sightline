# Dave — AWS inventory, graph and agent

A thin slice of the dave.io product: connect to a customer's AWS account with a
read-only role, ingest what is there and how it fits together, and put an agent
on top that answers questions a DevOps engineer would act on.

Built for the dave.io engineering assignment. It runs end to end against a
mocked AWS account with no credentials and no cloud spend.

```
AWS (real or mock) ──▶ scanner ──▶ Postgres ──▶ Neo4j ──▶ agent ──▶ React UI
                       assume-role  system of   graph     curated   graph +
                       per service  record      projection tools    chat
                       per region
```

---

## Running it

You need Docker and Node 20+. Nothing else — no AWS account, no credentials.

```bash
git clone <this repo> && cd dave.io_home-assignment
cp .env.example .env
docker compose up -d          # Postgres, Neo4j, and moto (mock AWS)
npm install

npm run seed                  # build the fictional customer account
npm run scan                  # discover it, persist it, build the graph

npm run dev:api               # http://localhost:3000
npm run dev:web               # http://localhost:5173   ← open this
```

`npm run seed` and `npm run scan` are also reachable from the UI: open it with
an empty database and the empty state offers to run the first scan.

To see change detection, make the account drift and scan again:

```bash
npm run drift                 # a bucket goes public, a port opens, an instance stops
npm run scan
```

The **Changes** tab then separates what matters from bookkeeping. Two buckets
receive the same permissive policy and only one becomes public — the other's
access block neutralises it — which is the clearest demonstration that verdicts
are computed rather than read off a field.

The header carries three more things.

**Demo / My AWS** switches between the seeded fixture and a real account at
runtime, without restarting or rewriting `.env`. Switching does not rescan, so
the graph keeps showing the previous account until you run one — the banner says
so rather than letting you read one account's inventory under another's name.

**Trust** shows what is checked and when it last ran: the data checks run on
demand in milliseconds with no API key, and the last agent eval run is shown.

Clicking any flagged node opens **How to fix** alongside the verdict: the exact
commands, what each one might break, and a read-only way to confirm it worked.
Nothing in the product runs them.

**Connection** is a step-by-step guide for pointing this at a real AWS account.
It generates an external id, pre-fills the CloudFormation command with the
identity this backend runs as, and tests the connection — diagnosing failures
rather than echoing SDK errors.

### The LLM key

The agent uses Anthropic. Put a key in `.env`:

```bash
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-5   # default
```

Everything except chat works without one — the scan, the graph, the findings
sidebar, and the entire tier-1 eval suite. `/api/health` tells you whether a
key is configured rather than making you discover it through a failed request,
and names the `.env` it read if the key is missing.

**Restart the API after editing `.env`.** Configuration is read once at startup
and `tsx watch` does not watch `.env`, so an edit while `npm run dev:api` is
running changes nothing until you restart it.

### Running against a real AWS account

The scanner does not know it is talking to a mock. Point it at a real account
by deploying the role in [`infra/readonly-role.yaml`](infra/readonly-role.yaml)
and setting:

```bash
AWS_MODE=real                 # drops the endpoint override
AWS_TARGET_ROLE_ARN=arn:aws:iam::<customer>:role/DaveIoReadOnlyRole
AWS_EXTERNAL_ID=<the per-customer secret>
AWS_SCAN_REGIONS=             # empty = discover every enabled region
```

In `real` mode the source credentials come from the standard AWS chain
(environment, shared config, container or instance role). Assume-role,
pagination, adaptive retry, region fan-out and partial-failure handling are the
same code in both modes.

The UI's **Connect** panel walks through this interactively — it generates an
ExternalId, renders the exact `aws cloudformation deploy` command pre-filled
with the principal to trust, and tests the result. Three things it gets right
that are easy to get wrong by hand, all of which cost a real deployment
(engineering log #28):

- **Two ARNs are involved and each looks like a valid value for the other.**
  `DaveIoScannerRoleArn` is an _input_ — the principal allowed to assume.
  `AWS_TARGET_ROLE_ARN` is the stack's `RoleArn` _output_ — the role that gets
  assumed. `sts:AssumeRole` can only assume a role, so a user ARN in the second
  can never work; the API refuses it by name at startup rather than failing
  later with `AccessDenied`.
- **`aws sts get-caller-identity` does not print a principal ARN.** It reports
  your _session_, so it returns `arn:aws:sts::…` — either
  `assumed-role/Role/session` or, on some endpoints, `user/name`. A trust policy
  needs the `arn:aws:iam::…` identity behind it. The guide converts it; pasting
  the raw value fails the template's own parameter pattern.
- **The trust policy must name the identity the backend actually runs as**,
  which is not necessarily the one you had in mind when you deployed. When
  AssumeRole is refused, the connection test prints the principal it is
  authenticating as and the command to show what the policy names.

Note that `AWS_SCAN_REGIONS=` blank means "discover every enabled region", and
is one of only two variables where blank is meaningful rather than unset.

### Useful commands

| Command                                     | What it does                                           |
| ------------------------------------------- | ------------------------------------------------------ |
| `npm run seed`                              | Rebuild the mock account from scratch                  |
| `npm run scan`                              | Scan, persist, project the graph                       |
| `npm run drift`                             | Change the mock account, so a second scan has a diff   |
| `npm run inspect -w @daveio/api`            | Scan and print findings without touching the databases |
| `npm run query -w @daveio/api`              | Run every curated query against the graph              |
| `npm test`                                  | 250 unit tests                                         |
| `npm run verify`                            | Everything CI's static job runs — use before pushing   |
| `npm run evals:ground-truth -w @daveio/api` | Tier-1 evals — no API key needed                       |
| `npm run evals -w @daveio/api`              | Tier-2 agent evals — needs a key                       |

---

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

# Design note

## Why this storage model, and how it serves the agent's questions

**Both databases, with a strict hierarchy: Postgres is authoritative and Neo4j
is a rebuildable projection of it.**

Neo4j earns its place because the brief's questions are overwhelmingly about
relationships, and one of them — _what can reach the production RDS instance?_
— is a variable-length path query. In Cypher that is one `MATCH` with a `*1..n`
hop. In SQL it is a recursive CTE over a junction table that nobody will enjoy
maintaining. The graph is not decoration; it is the shape of the problem.

Postgres earns its place because three things fit badly in a graph:

- **Scan history.** _What changed since the last scan?_ needs immutable
  snapshots over time, not a mutable current-state graph.
- **Partial failure.** Per-`(service, region)` status, error codes, durations
  and API-call counts are a plain relational fact table.
- **Agent traces.** Conversations, tool calls and eval results are relational
  and high-volume, and must never compete with the queries the agent runs.

The hierarchy is what makes running two stores tolerable. Each scan writes
immutable snapshots to Postgres, then rebuilds the Neo4j projection in one
transaction. There is exactly one writer and one direction of flow. If Neo4j is
lost, or the graph model changes, it replays from Postgres with no rescan and
no further AWS calls — which makes the graph disposable, and therefore safe to
change.

**The decision underneath this one matters more.** Questions like _which
buckets are public?_ are security reasoning, not data lookup: a bucket is
public if its policy or ACL grants a wildcard principal **and** neither the
bucket-level nor account-level public access block overrides it. That reasoning
is done **deterministically, in code, at ingest time** — never by the model.
Analysers compute `isPublic`, `isAdmin`, `isIdle` and the derived `CAN_REACH`
edges, each paired with a `reason` string recording its evidence.

So the graph the agent queries does not contain raw AWS JSON for it to
interpret. It contains verdicts that a unit test can check, with the evidence
attached. That is what makes the agent's answers auditable, and it is why
`prod-db-sg allows tcp/5432 from prod-app-sg, which prod-app-1 belongs to` can
be quoted verbatim rather than paraphrased by a model that might get it wrong.

## How the agent works, and why it is built that way

A plain tool-calling loop over **sixteen curated, parameterised tools** — no
agent framework. The model chooses which tool to call and with what arguments;
it never writes the query.

Text-to-Cypher was the obvious alternative and was rejected on four counts.
_Safety_: the brief's one hard rule is that the agent must never change
anything, and a curated tool cannot express a mutation. _Correctness_:
hand-written Cypher for "every path from the internet to this resource" is
reviewable, testable and identical on every run. _Cost_: a tool call returns
rows, whereas text-to-Cypher tends to return a schema, a failed query, an error
and a retry. _Auditability_: because every tool records exactly which ARNs it
returned, citations can be validated mechanically.

There is still a `graph_query` escape hatch for genuinely novel questions. It
runs behind a lexical write-clause validator **and** inside a Neo4j read
transaction, because neither layer is trusted alone.

No framework, because the two decisions that actually define this agent — the
tool boundary and citation validation — are precisely what a framework would
hide behind its own abstractions, without removing any of the real work.

**"Never change anything" is enforced at four layers**, not asserted in a
prompt: the IAM role has no write permissions and an explicit deny on data
reads; the scanner only ever calls `Describe`/`List`/`Get`; no tool can express
a mutation; and raw Cypher is validated and run read-only.

That is also why **remediation is generated and never applied** ([ADR-014](docs/DECISIONS.md)).
Every finding carries the exact commands that would fix it, what each one might
break, and a read-only command to confirm it worked — as strings. There is no
endpoint that executes them. A "Fix it" button would undo the three guarantees
above in one click, and the honest version is more useful anyway: the person who
knows whether a public bucket is a mistake or a deliberate CDN origin is at the
keyboard, not in the scanner. The commands are computed from the same evidence
as the verdict, not written by the model — the fixture's admin role gets its
`*:*` from an inline policy called `legacy-deploy-inline`, so the obvious
`detach-role-policy --policy-arn .../AdministratorAccess` would run cleanly and
fix nothing. And `caution` is a required field: an unprotected bucket rates
**low risk** because no anonymous access exists to lose, while a genuinely
public one rates high.

One honest boundary: **Neo4j Community has no role-based access control**, so a
read-only database _user_ is not available. In production this would be an
Enterprise read-only role or a read replica. Recorded in
[engineering log #7](docs/ENGINEERING-LOG.md) rather than glossed over.

## How I know the answers are right, and how I would know if a change made it worse

Two eval suites that fail for different reasons ([ADR-008](docs/DECISIONS.md)).

**Tier 1 — ground truth over the data.** Seeds the mock account, runs a real
scan, and asserts the result against the hand-written answer key. **No model,
no API key, about two seconds**, and it runs in CI on every commit. Fifteen
checks, including the ones that matter most: the neutralised bucket is
_not_ public, the inline-admin role _is_ admin, the private database is
reachable by both expected chains, and the publicly-flagged database is
reachable by none.

**Tier 2 — answer quality.** Twenty-one cases against the live agent, scored on
the ARNs each answer cites, with precision and recall.

Last recorded full run on `claude-sonnet-5`: **21/21, mean F1 1.0, no
unsupported citations** — one case per question the brief names, plus fifteen
more.

Getting there is the better advertisement for the suite than the score is. It
caught two real problems. One was a defect in a test rather than an answer
(engineering log #13). The other was the agent answering _"please delete this
volume"_ with the volume's details and a CLI command — safe, useful, and never
saying it could not act. Three attempts to fix that by prompting failed,
including one where the Style rules turned out to be competing with the
constraint; the guarantee now lives in code (ADR-009, engineering log #15). Each case asserts what
must be cited, what must **not** be (the traps), and which tools should have
been chosen. Precision matters as much as recall precisely because of the
traps: an answer naming every bucket achieves perfect recall and is useless.

**Underneath both, citation validation.** Every tool records the ARNs it
returned; every ARN in an answer is checked against that set, and anything
unsupported is flagged on the response and shown to the user. This turns the
most dangerous failure mode — a confident, plausible, invented identifier —
from something a prompt hopes to prevent into something the system detects.
Any unsupported citation fails an eval case outright.

**How I would know a change made it worse:** tier 1 fails in CI within
seconds; tier 2 produces a mean F1 and a pass count, stored in `eval_runs` and
written to `evals/results/` so two runs can be diffed. The split also makes
failures diagnosable — if tier 1 passes and tier 2 fails, the data is right and
the agent misused it, which is a prompt or tool-description problem. If tier 1
fails, nothing about the agent is worth looking at yet.

**What this does not catch**, stated plainly: an answer that cites exactly the
right resources and describes them wrongly. The `mustMention` patterns cover
the cases where that has teeth, but a genuinely adversarial wrong answer with
correct citations would pass. Closing that needs an LLM judge over a larger
case set, which is on the list below.

## What breaks first on a large account

In the order it would actually happen:

**1. The graph rebuild, at roughly 50k resources.** Neo4j is rebuilt wholesale
in one transaction. That is simple and leaves no stale nodes, but it is O(all
resources) per scan and the transaction gets large. _Fix:_ diff the Postgres
snapshots — which already exist — and `MERGE` only what changed. The snapshots
were designed with this in mind.

**2. Scan wall-clock, across many regions.** 6 services × 30 regions is 180
units at a concurrency of 6. Because per-bucket S3 calls are four API calls
each, an account with 10,000 buckets is 40,000 calls in one unit.

Partly addressed: the Resource Explorer fast path asks one indexed query which
regions actually hold resources and skips the rest, so an account with 30
enabled regions and resources in four scans 4 regions rather than 30. It cannot
do more than that — a search result carries an ARN, type and region, not the
security group rules or bucket policies every question here depends on, so the
detailed Describe calls still happen. It is also unavailable on any account
without an aggregator index, which a read-only role cannot create, and it cannot
be exercised against the mock at all. _Remaining fix:_ per-service concurrency
rather than one global limit, and splitting oversized units.

**3. Throttling, well before that.** `retryMode: adaptive` handles bursts, but
a full parallel scan of a busy account will hit service quotas — and worse,
compete with the customer's own workloads. _Fix:_ a token bucket per
`(service, region)` sized from published quotas, and a scan budget the customer
controls.

**4. The frontend, at about 2,000 nodes.** React Flow renders every node; dagre
layout is O(V+E) but the DOM is not. Already mitigated by filtering noisy kinds
by default. _Fix:_ server-side aggregation — collapse a VPC to one node until
expanded — and viewport virtualisation.

**5. The agent's context, on broad questions.** Tool results are capped at 12k
characters and truncated. On a large account "list all EC2 instances" is
useless anyway. _Fix:_ tools should return aggregates with drill-down rather
than rows, and say so when truncating.

**What does not break:** partial failure handling and credential renewal both
get _more_ useful at scale, which is why they were built in from the start
rather than added later.

**Multi-tenancy** is the other axis. Today a single module-level flag tracks
whether a scan is running, and the graph holds one account. Multi-tenant needs
an account id on every node and query, per-tenant credential caching, and a job
queue instead of an in-process scan. The storage model already carries
`accountId` on every resource; the scan orchestration is what would change.

## What I would build next, given another week

1. **Incremental graph updates.** The highest-value change: it removes the
   first scaling limit and makes scans cheap enough to run continuously rather
   than on demand.
2. **Real idle detection.** Current idle findings use structural signals only —
   attached to nothing, associated with nothing, stopped. CloudWatch metrics
   and Cost Explorer would turn "this volume is unattached" into "this instance
   has been under 2% CPU for thirty days", which is a much more useful finding.
   The role already grants the permissions.
3. **An LLM judge over a larger eval set.** Closes the gap named above, and
   makes prompt changes safe to make quickly.
4. **Change detection as a first-class feature.** Scan diffing exists and the
   agent can query it, but the UI does not surface it. "What changed since
   yesterday, and does any of it matter?" is the question that makes this a
   product someone opens daily rather than once.
5. **More of the account.** ELB, ECS, EKS, API Gateway, CloudFront and
   Route 53. The collector interface is deliberately small — each is an
   afternoon — and load balancers in particular would fill a real gap in the
   reachability graph.
6. **NACLs, peering and Transit Gateway in the reachability model.** Today the
   analysis is conservative: it can miss a path, but a path it reports is
   justified by rules that really exist. Peering and Transit Gateway are the
   biggest honest gaps.

---

## Notes on the brief

Taking up the invitation to say what could have been clearer or different.

**`ReadOnlyAccess` is the sharpest thing in the brief, and I suspect
deliberately so.** The supplied template grants it while the evaluation
criteria ask whether candidates understand "what read-only really means". It
grants ~7,000 actions including `s3:GetObject`, `secretsmanager:GetSecretValue`
and `lambda:GetFunction` (which returns a presigned URL to function source). An
inventory product never needs to read an object out of a bucket, and granting
the ability turns a compromise of dave.io's platform account into a compromise
of every customer's _data_.

`sqs:ReceiveMessage` is the detail I would flag to a real customer: it is not
read-only even literally, since receiving a message starts its visibility
timeout and can hide it from the consumer that should have processed it. A
scanner holding that permission can breach the brief's own hard rule through a
permission nobody thinks of as a write.

I replaced the template — `SecurityAudit` + `ViewOnlyAccess` plus an explicit
`Deny` on data-plane reads, trust scoped to the scanner role rather than
`:root`, and `sts:SourceIdentity` so customers can attribute scans in their own
CloudTrail. The original is kept alongside for comparison, and the reasoning is
in [ADR-007](docs/DECISIONS.md).

**Two smaller things.** The trust policy's `Principal: ...:root` is worth
calling out in the brief itself — it reads like "the root user" but means every
principal in the account, and that is a common misreading rather than a
candidate trap. And **AWS Resource Explorer needs an index created in the
customer account**, which a read-only role cannot do. It is excellent advice
for accounts that have it enabled, but as suggested it cannot be relied on;
the scanner treats it as an optional fast path with SDK enumeration as the
tested fallback.

---

## Repository layout

```
apps/api            backend: scanner, analysers, graph, agent, HTTP API
  src/aws/          credentials, instrumented clients, region discovery
  src/scan/         collectors, analysers, orchestration
  src/db/           Postgres schema and repository, Neo4j projection, queries
  src/agent/        tools, Cypher guard, citation validation, the loop
  src/evals/        tier-1 ground truth, tier-2 cases and grading
apps/web            React frontend: graph, chat, findings, UX states
packages/shared     domain model shared by every package
packages/mock-aws   the seeded customer account and its answer key
infra/              the replacement read-only role, and the original
docs/               decisions, engineering log, commit log, walkthrough
```

## Documentation

- **[docs/DECISIONS.md](docs/DECISIONS.md)** — fourteen ADRs: the stack, the
  mock, the two-database split, deterministic analysis, the tool boundary,
  citation validation, the IAM role, the eval strategy, the read-only refusal in
  code, guided onboarding, evals shown in the product, public vs unprotected,
  the runtime account toggle, and remediation that is never applied.
- **[docs/ENGINEERING-LOG.md](docs/ENGINEERING-LOG.md)** — every non-obvious
  problem hit while building this, with diagnosis and fix. Includes a silent
  moto account-namespacing trap, two capability gaps in the mock recorded as
  gaps rather than hidden, and an SDK type that degraded to `any` behind
  `skipLibCheck`.
- **[docs/COMMITS.md](docs/COMMITS.md)** — what each commit changed and why.
- **[docs/WALKTHROUGH.md](docs/WALKTHROUGH.md)** — a guided tour of the running
  system.
