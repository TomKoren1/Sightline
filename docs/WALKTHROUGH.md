# Walkthrough

A guided tour of the running system, and the reasoning behind the parts that
are not obvious from the code. Written to be read before demonstrating or
discussing this project.

---

## 1. The demo, in order

Seven minutes, arranged so each step sets up the next.

### Start from empty

```bash
docker compose down -v && docker compose up -d
npm run dev:api & npm run dev:web
```

Open http://localhost:5173. The empty state explains what a scan does and
offers to run one. **Point out that this is a real state, not a placeholder** —
a new customer sees exactly this.

### Run the scan from the UI

Click **Run the first scan**. Watch the banner:

- The full plan appears immediately — every `(service, region)` unit it intends
  to scan — and fills in as units complete. It does not grow a list as work
  finishes; the user can see the whole shape of the job from the first second.
- Progress is per service and region, not a percentage guess.
- It takes about four seconds against the mock and makes ~87 AWS API calls.

### The graph

Laid out left to right, so reachability reads the way people expect: the
internet on the left, what it can touch to the right, the database at the end.

- Red-bordered nodes are reachable from the internet. `northwind-prod-db` is
  among them **despite being `PubliclyAccessible: false` in a private subnet**.
- Click it. The detail panel leads with the verdict and its evidence, not a
  property dump.
- `analytics-db` is _not_ red, even though it is flagged publicly accessible.

### Ask the agent the question the brief asks

> What can reach the production RDS instance?

While it works, the chat names the tool that is running — _"Tracing network
paths"_ — rather than showing a spinner. When the answer arrives:

- Resources it cites light up in the graph, everything else dims, and the view
  re-frames onto them.
- Expand **tool calls** to see exactly which tools ran, with row counts and
  timings.

The answer should name **both** routes: the three-hop path through the web and
app tiers, and the shorter one through the bastion.

### Then ask the trap

> The analytics-db instance has PubliclyAccessible set to true. Is it actually
> exposed?

The correct answer is no — its security group opens no ports. This is the
clearest demonstration that the agent is reading computed facts rather than
paraphrasing an AWS field.

### Show change detection

```bash
npm run drift && npm run scan
```

Open the **Changes** tab. Five things changed; three are grouped as _worth
looking at_ and the rest as routine.

The one to dwell on: `northwind-logs-archive` and `northwind-terraform-state`
both received the **same** permissive bucket policy, and only the first shows
`derived.isPublic: false → true`. The second's public access block neutralised
it. A diff that flagged them identically would be reading the policy instead of
evaluating it — this is the deterministic-analysis argument (ADR-004) visible in
one screen.

### Show the Trust panel

Header → **Trust**.

- **Data checks** run on demand: twelve checks, no model, no API key, about
  10ms. Expand one to see what it guards against and what it found.
- **Agent answer quality** shows the last recorded eval run — 16/16, mean F1
  1.0, no unsupported citations — with the model that produced it.

If drift has been applied, the data checks deliberately show **amber, not red**,
with an explanation: they assert properties of the pristine fixture, so a
failure after drift is them detecting the drift. Worth pointing out — an
indicator whose false positives are not handled gets ignored, and then it is
worse than absent.

### Show the onboarding guide

Header → **Connection**. Five steps, and step 4 is the one to talk about: there
is deliberately **no form** for pasting a role ARN, because this API has no
authentication and that form would be an open endpoint assuming a role into
someone's AWS account while storing a credential. The screen says so.

Press **Test connection** — `AssumeRole` plus `GetCallerIdentity`, and on
failure it names the specific thing to fix rather than echoing an SDK error.

### Show partial failure

```bash
# In .env, then restart the API:
SCAN_FAULT_INJECTION=rds:eu-west-1,lambda:ap-southeast-1
```

Rescan. An amber banner names each failed service and region, in language that
says what to do about it. **The data that did scan is still shown** — that is
the point. Ask the agent _"did anything fail in the last scan?"_; it warns
about the gap, because failed units are injected into its system prompt.

### Show the safety rule

> Please delete the orphaned-vol-1 volume to save money.

It declines, explains it is read-only by design, and says what it would change.

---

## 2. Architecture, in one pass

```
AWS or moto
    │  sts:AssumeRole + ExternalId, renewed 5 min before expiry
    ▼
scanner ──── one unit per (service, region), bounded concurrency,
    │        each unit fails independently
    ▼
analysers ── isPublic / isAdmin / isIdle / CAN_REACH, computed in code,
    │        each with a `reason` recording its evidence
    ▼
Postgres ─── system of record: immutable snapshots, scan units, agent traces
    │
    ▼
Neo4j ────── derived projection, rebuilt in one transaction
    │
    ▼
tools ────── 13 curated parameterised queries + a guarded Cypher escape hatch
    │
    ▼
agent ────── tool-calling loop, citations validated against tool results
    │
    ▼
React ────── graph + chat sharing one highlight mechanism
```

**The single most important line in that diagram is the analysers.** Everything
above them is collection; everything below reads verdicts that code produced
and tests can check.

---

## 3. The three decisions to lead with

If there is time for only three points, use these.

### Security reasoning is computed in code, never by the model

_Which S3 buckets are public?_ looks like retrieval. It is not: a bucket is
public if its policy **or** its ACL grants a wildcard principal, **and**
neither the bucket-level nor the account-level public access block overrides
it. The mock account contains two buckets with byte-identical policies where
exactly one is effectively public.

So the analyser computes the verdict and records the evidence, and the model
reads both. This moves the part that must be correct into code that can be unit
tested, and leaves the model doing what it is good at: choosing a query,
combining results, and explaining them. It also makes a wrong answer
_debuggable_ — a bad verdict is a failing test on an analyser, not a prompt to
reword.

→ `apps/api/src/scan/analysers/`, ADR-004

### Citations are validated mechanically

Every tool records the ARNs it returned. After the model answers, every
identifier in that answer is checked against that set, and anything unsupported
is flagged on the response and shown to the user.

The failure mode that matters for a tool someone acts on is not a vague
answer — it is a confident, plausible, invented resource identifier. Prompting
cannot rule that out; this detects it, deterministically and independently of
the model.

→ `apps/api/src/agent/citations.ts`, ADR-006

### A scan does not fail

Every `(service, region)` pair succeeds or fails alone. A throttled RDS call in
`eu-west-1` never invalidates a clean EC2 inventory in `us-east-1`. Failures
are translated into something actionable: `UnauthorizedOperation` becomes _"the
role is missing a Describe/List permission for this service"_, not a stack
trace.

A half-scan that says which half is missing is far more useful than an error
page — and this gets _more_ valuable at scale, not less, which is why it was
designed in rather than added later.

→ `apps/api/src/scan/runner.ts`

---

## 4. Questions to expect, and the honest answers

**"Why both databases? Isn't that over-engineering?"**
The hierarchy is the answer: Postgres is authoritative, Neo4j is a rebuildable
projection. One writer, one direction. Neo4j exists because _what can reach the
production database?_ is a variable-length path query — one line of Cypher, a
recursive CTE in SQL. Postgres exists because scan history, partial-failure
records and agent traces fit badly in a graph. If pushed to drop one: drop
Neo4j, because it can be replayed; the answer quality on path questions would
get worse.

**"Why not text-to-Cypher? It's more flexible."**
Safety, correctness, cost and auditability. A curated tool cannot express a
mutation, which is the brief's hard rule. Hand-written path queries are
reviewable and identical every run. And because each tool records exactly which
ARNs it returned, citations can be validated — which text-to-Cypher makes much
harder. The escape hatch exists for genuinely novel questions, behind a
validator and a read transaction.

**"How do you know the agent is right?"**
Two suites that fail for different reasons. Tier 1 asserts the _data_ against a
hand-written answer key, needs no API key, and runs in CI in about two seconds.
Tier 2 scores _answers_ on cited ARNs with precision and recall. The split
makes failures diagnosable: tier 1 passing and tier 2 failing means the data is
right and the agent misused it.

**"What can't it do?"** — answer this one before being asked:
Reachability ignores NACLs, VPC peering and Transit Gateway, so it is
conservative: it can miss a path, but a path it reports is justified by rules
that really exist. Idle detection uses structural signals only, not CloudWatch
metrics. The account-level S3 public access block is not read. Admin detection
ignores conditioned statements and `NotAction` rather than guessing at them.
Every one of these is a deliberate boundary, and every derived fact carries its
reason so a reviewer can disagree.

**"Is it really read-only?"**
Four layers: the IAM role has no write permissions and an explicit deny on
data-plane reads; the scanner only calls `Describe`/`List`/`Get`; no tool can
express a mutation; raw Cypher is validated and run in a read transaction. One
honest gap: **Neo4j Community has no RBAC**, so a read-only database _user_ is
not available — in production that would be Enterprise RBAC or a read replica.

**"Why did you change the IAM role?"**
`ReadOnlyAccess` grants ~7,000 actions including `s3:GetObject` and
`secretsmanager:GetSecretValue`. An inventory product never needs to read an
object out of a bucket, and granting it turns a compromise of dave.io's account
into a compromise of every customer's _data_. `sqs:ReceiveMessage` is the
sharpest detail: it is not read-only even literally, because receiving a
message starts its visibility timeout and can hide it from the consumer that
should have processed it — a scanner could breach the brief's hard rule through
a permission nobody thinks of as a write.

**"Why moto rather than a real account?"**
It preserves the SDK boundary completely — assume-role, pagination, adaptive
retry, region fan-out and partial-failure handling are all the real
implementations, and the only difference is an endpoint override. It also makes
ground truth _knowable_, which is what tier-1 evals depend on. LocalStack
community cannot do RDS, which settled it. The honest costs are in the
engineering log: moto does not simulate pagination (so that is unit-tested
against a stub instead) and has no Resource Explorer.

---

## 5. If something goes wrong mid-demo

| Symptom                     | Cause                              | Fix                                                                                            |
| --------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| Chat returns 401            | Bad or missing `ANTHROPIC_API_KEY` | `curl localhost:3000/api/health` says so directly                                              |
| Chat refuses to answer      | No scan yet                        | Run a scan; it refuses rather than answering from an empty graph                               |
| Graph is empty after a scan | Account id mismatch                | `MOCK_AWS_ACCOUNT_ID` must match the account in `AWS_TARGET_ROLE_ARN` — see engineering log #2 |
| Scan finds nothing          | moto was reset                     | `npm run seed` again; moto is in-memory                                                        |
| A service shows as failed   | Fault injection left on            | Clear `SCAN_FAULT_INJECTION` in `.env`                                                         |

Diagnosing a wrong answer, in order:

1. `npm run inspect -w @daveio/api` — is the **data** right?
2. `npm run query -w @daveio/api` — is the **query** right?
3. Expand tool calls in the UI — did it choose the right **tool**?

That sequence isolates collection from projection from reasoning, and it is why
both CLIs exist.

---

## 6. What to say about what is unfinished

Being direct about this is worth more than pretending otherwise.

- **Incremental graph updates.** The rebuild is wholesale. It is the first
  thing that breaks at ~50k resources, and the Postgres snapshots were designed
  so the fix is a diff rather than a rewrite.
- **Change detection is built but not surfaced.** Scan diffing works and the
  agent can query it; the UI does not show it. _"What changed since yesterday,
  and does any of it matter?"_ is the question that would make this a product
  someone opens daily.
- **Idle detection is structural.** CloudWatch metrics would turn "this volume
  is unattached" into "this instance has been under 2% CPU for thirty days".
  The replacement role already grants the permission.
- **Multi-tenancy is gestured at, not built.** Every resource carries an
  `accountId`; scan orchestration uses a module-level flag and would need a job
  queue.
