# Walkthrough

A guided tour of the running system, and the reasoning behind the parts that
are not obvious from the code. Written to be read before demonstrating or
discussing this project.

---

## 0. Before recording

Two settings decide whether any of this works, and both are easy to get wrong
because they are invisible on screen.

**`.env` must point at the mock account.** If it holds a real
`AWS_TARGET_ROLE_ARN` and `AWS_MODE=real`, the API starts against that account
and every step below describes something you are not looking at. Either set
`AWS_MODE=mock`, or leave it and press **Demo** in the header before starting —
the toggle is a legitimate thing to show, and it switches without a restart.

**`SCAN_FAULT_INJECTION` must be empty**, or the partial-failure banner appears
in every shot rather than the one where it is the point.

A dry run of the whole script before recording is worth the eight minutes: it
also leaves a recorded eval run for the Trust panel to display.

---

## 1. The demo, in order

About eight minutes, arranged so each step sets up the next.

### Start from empty

```bash
docker compose down -v && docker compose up -d
npm run seed                    # moto is in-memory: a fresh container is an empty account
npm run dev:api & npm run dev:web
```

`npm run seed` is not optional here. `down -v` discards moto's volume along
with the databases, and a scan of an unseeded account finds nothing — which
looks exactly like a broken product on camera.

Open http://localhost:5173. The empty state explains what a scan does and
offers to run one. **Point out that this is a real state, not a placeholder** —
a new customer sees exactly this.

### Run the scan from the UI

Click **Run the first scan**. Watch the banner:

- The full plan appears immediately — every `(service, region)` unit it intends
  to scan — and fills in as units complete. It does not grow a list as work
  finishes; the user can see the whole shape of the job from the first second.
- Progress is per service and region, not a percentage guess.
- It takes two to three seconds against the mock and makes 101 AWS API calls,
  across fourteen units: six services over three regions, with IAM and S3
  scanned once because their resources are global.

### The graph

Laid out left to right, so reachability reads the way people expect: the
internet on the left, what it can touch to the right, the database at the end.

- Red-bordered nodes are reachable from the internet. `northwind-prod-db` is
  among them **despite being `PubliclyAccessible: false` in a private subnet**.
- Click it. The detail panel leads with the verdict and its evidence, not a
  property dump.
- `analytics-db` is _not_ red, even though it is flagged publicly accessible.

### Ask the agent the question this exists for

> What can reach the production RDS instance?

While it works, the chat names the tool that is running — _"Tracing network
paths"_ — rather than showing a spinner. When the answer arrives:

- Resources it cites light up in the graph, everything else dims, and the view
  re-frames onto them.
- Expand **tool calls** to see exactly which tools ran, with row counts and
  timings.

The answer names **five** distinct chains, not two: one two-hop path through
the SSH bastion, and four three-hop paths through the web tier into either the
app instance or the order-processor Lambda. Each is justified by named security
group rules rather than asserted. Checked against a pristine fixture while
writing this, so it is what you should expect to see.

### Then ask the trap

> The analytics-db instance has PubliclyAccessible set to true. Is it actually
> exposed?

The correct answer is no — its security group opens no ports. This is the
clearest demonstration that the agent is reading computed facts rather than
paraphrasing an AWS field.

### Show the finding that a role-only scanner misses

Findings sidebar → **Admin**. Five principals hold effective `*:*`, and the
list deliberately mixes **roles and users**:

- `NorthwindAdminRole` — the obvious one, via the managed `AdministratorAccess`
- `LegacyDeployRole` — via an **inline** policy called `legacy-deploy-inline`,
  so the name says nothing about what it grants
- `UnusedAdminRole` — privileged and used by nothing
- `northwind-backup-agent` — an IAM **user**, admin via an inline policy called
  `BackupHelper`
- `northwind-ci-deploy` — an IAM user with `AdministratorAccess` attached

The two users are the point. Admin detection originally read roles only, and
against a real AWS account administered through IAM users it reported that
nobody had administrator access — 157 tests passed, because the fixture had no
users either. A fixture that shares the code's blind spot proves nothing
(engineering log #29).

Worth adding, if asked why users matter more: a role is assumed and issues
credentials that expire; a user has access keys that do not.

### Show that it will not fix it for you

Click `LegacyDeployRole` → **How to fix**.

- The commands are **computed from the same evidence as the verdict**, not
  written by the model. This role's admin comes from an inline policy, so the
  suggestion is `get-role-policy` into `backup.json`, then `put-role-policy`
  with a scoped replacement. The obvious
  `detach-role-policy --policy-arn …/AdministratorAccess` would exit zero and
  fix nothing, and that is exactly what a model would have produced.
- The **caution is rendered above the commands**, and it names what breaks:
  _"legacy-image-resizer currently uses this role, and will lose every
  permission it grants the moment this is applied."_ That sentence is generated
  from the graph edges into the role.
- There is a copy button and **no apply button**, anywhere in the product.

The absence is the feature: a Fix button would undo the read-only position in
one click, and the person who knows whether a public bucket is a mistake or a
deliberate CDN origin is at the keyboard, not in the scanner (ADR-014).

### Show change detection

```bash
npm run drift && npm run scan
```

If the tab shows everything as added and removed, moto was re-seeded between
the two scans and every ARN changed. Run `npm run seed && npm run scan` once,
then `npm run drift && npm run scan`, with nothing in between — the
ground-truth test suite re-seeds moto, so it counts as something in between.

Open the **Changes** tab. Six things changed — one added, five modified — and
they are grouped rather than listed: **three worth looking at**, two routine,
and the new volume. The grouping is computed from which _fields_ changed, so a
security verdict flipping and an instance gaining a tag are not shown as equals.

The three notable ones are a bucket that became public, a stopped instance that
became idle, and a security group whose ingress rules changed.

The one to dwell on: `northwind-logs-archive` and `northwind-terraform-state`
both received the **same** permissive bucket policy. Only the first shows
`derived.isPublic: false → true` and is grouped as notable; the second shows
only `policy` and `publicReason` changing and sits under routine, because its
public access block neutralised the policy. A diff that flagged them identically would be reading the policy instead of
evaluating it — this is the deterministic-analysis argument (ADR-004) visible in
one screen.

### Show the Trust panel

Header → **Trust**.

- **Data checks** run on demand: fifteen checks, no model, no API key, about
  ten milliseconds. Expand one to see what it guards against and what it found.
- **Agent answer quality** shows the last recorded eval run — 21/21, mean F1
  1.0, no unsupported citations — with the model that produced it. If it says
  "no run recorded", run `npm run evals -w @sightline/api` before recording; it
  needs an API key and a few minutes.

If drift has been applied, two data checks turn **amber with a `◆` and
"expected after drift"**, not red — `public-buckets` because
`northwind-logs-archive` genuinely became public, and `idle-resources` because
`new-unattached-vol` and a stopped `prod-web-2` genuinely are billable and idle.
Expand one: it names the mutation that caused it. This is the strongest thing to
say about the panel, because the attribution is **per check, not a blanket
caveat** — the note reads "all 2 failing checks are accounted for", and if a
third failed for any other reason the panel stays red and names it. An indicator
whose false positives are not handled gets ignored; one that excuses every
failure at once is worse, because it would hide a real regression (engineering
log #41).

### Show the onboarding guide

Header → **Connection**. Start at **Before you start**: it names the two
identities people conflate — _your_ admin credentials, used once to create the
role and never stored, versus _this backend's_ principal, which is what the
trust policy names and is already filled in for you. `aws sts get-caller-identity`
is there because deploying into the wrong account is the easy mistake, and it
only surfaces two steps later as a confusing `NoSuchEntity`.

Then point at any command block: every one carries a legend marking each value
**filled in** or **you replace**. Exactly one value on the whole page is the
reader's — `AWS_TARGET_ROLE_ARN` — and it is the only thing tagged in amber.

Five steps, and step 4 is the one to talk about: there
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
tools ────── 16 tools over 13 curated queries, + a guarded Cypher escape hatch
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
mutation, which is the read-only rule. Hand-written path queries are
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
object out of a bucket, and granting it turns a compromise of Sightline's account
into a compromise of every customer's _data_. `sqs:ReceiveMessage` is the
sharpest detail: it is not read-only even literally, because receiving a
message starts its visibility timeout and can hide it from the consumer that
should have processed it — a scanner could breach the read-only rule through
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

| Symptom                                        | Cause                                                         | Fix                                                                                                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat returns 401                               | Bad or missing `ANTHROPIC_API_KEY`                            | `curl localhost:3000/api/health` says so directly                                                                                                     |
| Chat refuses to answer                         | No scan yet                                                   | Run a scan; it refuses rather than answering from an empty graph                                                                                      |
| Graph is empty after a scan                    | Account id mismatch                                           | `MOCK_AWS_ACCOUNT_ID` must match the account in `AWS_TARGET_ROLE_ARN` — see engineering log #2                                                        |
| Scan finds nothing                             | moto was reset                                                | `npm run seed` again; moto is in-memory                                                                                                               |
| A service shows as failed                      | Fault injection left on                                       | Clear `SCAN_FAULT_INJECTION` in `.env`                                                                                                                |
| Changes tab shows everything added and removed | moto was re-seeded between the two scans, so every ARN is new | Re-seed once, then `scan` → `drift` → `scan` with nothing in between. The ground-truth test suite re-seeds moto, so it counts as something in between |

Diagnosing a wrong answer, in order:

1. `npm run inspect -w @sightline/api` — is the **data** right?
2. `npm run query -w @sightline/api` — is the **query** right?
3. Expand tool calls in the UI — did it choose the right **tool**?

That sequence isolates collection from projection from reasoning, and it is why
both CLIs exist.

---

## 6. What to say about what is unfinished

Being direct about this is worth more than pretending otherwise.

- **Incremental graph updates.** The rebuild is wholesale. It is the first
  thing that breaks at ~50k resources, and the Postgres snapshots were designed
  so the fix is a diff rather than a rewrite.
- **Scans are triggered by a person.** Diffing works, the agent can query it
  and the Changes tab shows it — but nothing runs on a schedule, so _"what
  changed overnight?"_ is only answerable if somebody remembered to scan last
  night. A scheduled scan plus a digest of what materially changed is what
  would make this a product someone opens daily.
- **Idle detection is structural.** CloudWatch metrics would turn "this volume
  is unattached" into "this instance has been under 2% CPU for thirty days".
  The replacement role already grants the permission.
- **Multi-tenancy is gestured at, not built.** Every resource carries an
  `accountId`, but the AWS connection is process configuration and scan
  orchestration tracks "is a scan running" in a module-level boolean — both
  correct for one operator and wrong the moment there are two. Real tenancy
  means a tenant on every row, credentials resolved per tenant rather than
  cached globally, and a job queue. Worth saying plainly if asked: the honest
  version of this is a week of work, not a flag.
