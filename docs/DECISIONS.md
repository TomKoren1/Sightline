# Architecture decision records

Each record states the problem, the options that were genuinely considered, the
decision, and what it costs. Recorded at the time the decision was made.

---

## ADR-001 — TypeScript across the whole repo

**Context.** The stack was unconstrained. The work spans an AWS scanner, two
databases, an LLM agent and a React graph UI.

**Options.**
- *Python backend, TypeScript frontend.* Best-in-class AWS tooling (`boto3`,
  `moto` in-process), and the richest agent-framework ecosystem. Costs a second
  toolchain, a second test runner, and a language boundary through which the
  domain model has to be restated.
- *TypeScript throughout.* One model definition shared by scanner, API and UI;
  one test runner; one CI pipeline.

**Decision.** TypeScript throughout.

**Why.** The domain model is the centre of this project — `Resource`,
`Relationship`, `ScanUnit`, the agent's wire types. Defining it once in
`packages/shared` and importing the *same types* into the scanner, the API and
the React components removes an entire class of drift. AWS SDK v3 is
TypeScript-first with generated types precise enough to catch real mistakes
(see engineering log #5). A reviewer reads one language.

**Cost.** Python's agent ecosystem is more mature, and `moto` would have been
usable in-process rather than over HTTP. The HTTP boundary turned out to be an
advantage — see ADR-002.

---

## ADR-002 — moto in Docker as the mock AWS control plane

**Context.** The brief allows a real AWS account or a mock. A mock had to be
convincing enough that the scanner's real behaviour — assume-role, region
fan-out, pagination, retries — is genuinely exercised rather than stubbed out.

**Options.**
- *A real AWS account.* Maximum fidelity, but reviewers cannot run it, costs
  money, and the interesting security topology would have to be built by hand
  in someone's account.
- *Hand-written fixtures behind a fake client.* Fast and fully controlled, but
  it deletes the entire AWS integration — credentials, paginators, error
  handling — which is a third of what is being assessed.
- *LocalStack (community).* Real AWS API surface. **Cannot do RDS** in the
  community edition, and the production database is the centre of the most
  interesting question in the brief.
- *moto in server mode.* Real AWS API over HTTP. Verified by probe to support
  STS assume-role, EC2/VPC, S3 (including bucket policy and public access
  block), IAM, **RDS**, and Lambda.

**Decision.** moto in server mode, as a compose service.

**Why.** It preserves the SDK boundary completely: the scanner builds ordinary
AWS clients and the only difference between mock and production is an endpoint
override and where the source credentials come from. Assume-role, pagination
code, adaptive retries, region fan-out and partial-failure handling are all the
real implementations. RDS support settled it against LocalStack.

**Cost.** moto does not simulate pagination (engineering log #3) or implement
Resource Explorer (#4), and does not enforce IAM authorisation — so the mock
cannot prove our least-privilege claims. Those gaps are covered by unit tests
and stated honestly rather than papered over.

---

## ADR-003 — Postgres as the system of record, Neo4j as a derived projection

**Context.** The brief supplies both databases and invites using either, both,
or neither. Using both because both were offered is not a reason.

**Decision.** Both, with a strict hierarchy: **Postgres is authoritative,
Neo4j is a rebuildable projection of it.**

**Why Neo4j at all.** The questions in the brief are overwhelmingly about
*relationships*, and one of them — "what can reach the production RDS
instance?" — is a variable-length path query over security group references.
In Cypher that is one `MATCH` with a `*1..n` hop. In SQL it is a recursive CTE
over a junction table that nobody on the team will enjoy maintaining. The graph
is not decoration; it is the shape of the problem.

**Why Postgres too.** Three things fit badly in a graph:
1. *Scan history.* "What changed since the last scan?" needs immutable
   snapshots over time, not a mutable current-state graph.
2. *Partial failure.* Per-`(service, region)` outcomes, error codes, durations
   and API-call counts are a plain relational fact table.
3. *Agent traces.* Conversations, tool calls and eval results are relational
   and high-volume, and must never pollute the graph the agent queries.

**Why the hierarchy matters.** Every scan writes immutable resource snapshots
to Postgres first, then rebuilds the Neo4j projection in one transaction tagged
with the scan id. If Neo4j is lost or its schema changes, it is replayed from
Postgres with no rescan and no further AWS API calls. That makes the graph
disposable, which in turn makes it safe to change the graph model.

**Cost.** Two stores to run and keep consistent. The hierarchy is what makes
this tolerable: there is exactly one writer, one direction of flow, and a
well-defined rebuild.

---

## ADR-004 — Security reasoning is computed in code, never by the model

**Context.** "Which S3 buckets are public?" looks like a retrieval question. It
is not. A bucket is public if its policy or ACL grants a wildcard principal
**and** neither the bucket-level nor account-level public access block
overrides that grant. Similarly, an IAM role is an administrator if the union
of its managed and inline policies grants `*` on `*` — which no policy *name*
reliably indicates.

**Options.**
- *Give the model the raw JSON and let it reason.* Flexible, and wrong often
  enough to be dangerous. A DevOps engineer acting on "this bucket is private"
  needs that to be a fact, not a generation.
- *Compute the facts deterministically during ingest; let the model select,
  combine and explain them.*

**Decision.** The second. Analysers in the ingest pipeline compute
`isPublic`, `isAdmin`, `isIdle` and the derived `CAN_REACH` edges, each paired
with a human-readable `reason` recording the evidence.

**Why.** It moves the part that must be correct into code that can be unit
tested against a known topology, and leaves the model doing what it is actually
good at: picking the right query, joining results, and explaining them in
English. It also makes wrong answers *debuggable* — a bad verdict is a failing
test on an analyser, not a prompt to reword.

**Cost.** The analysers encode our interpretation of reachability and
privilege, and that interpretation can be incomplete (we do not evaluate NACLs,
SCPs, or permission boundaries). Every derived fact therefore carries its
reason, so a reviewer can see the basis and disagree with it.

---

## ADR-005 — A curated tool library instead of text-to-Cypher

**Context.** The agent needs to query a graph. The obvious approach is to let
the model write Cypher.

**Decision.** The model calls typed, parameterised tools backed by
hand-written queries. A read-only `graph_query` escape hatch exists for
genuinely novel questions, behind a write-clause validator and a read
transaction.

**Why.**
- *Safety.* The brief's one hard rule is that the agent must never change
  anything. A curated tool cannot express a mutation.
- *Correctness.* Hand-written Cypher for "find every path from the internet to
  this resource" is reviewable, testable, and identical on every run.
- *Cost and latency.* A tool call returns rows; text-to-Cypher tends to return
  a schema, a failed query, an error, and a retry.
- *Auditability.* Every tool records the exact query it ran and the ARNs it
  returned, which is what makes citation validation (ADR-006) possible.

**Cost.** Questions nobody anticipated fall back to `graph_query` or are
answered incompletely. That is the right failure direction: a narrow correct
answer beats a broad unreliable one.

---

## ADR-006 — Citations are validated mechanically

**Context.** "How do you know the agent's answers are right?" is one of the
five questions the brief asks the README to answer.

**Decision.** Every tool result records the set of ARNs it returned. After the
model produces an answer, every ARN in that answer is checked against the union
of ARNs the tools actually returned. Any ARN that appears in neither is flagged
on the response.

**Why.** It converts the most dangerous failure mode — a confident, plausible,
invented resource identifier — from something we hope a prompt prevents into
something the system detects. It is cheap, deterministic, and independent of
the model.

**Cost.** It catches invented *identifiers*, not invented *relationships between
real identifiers*. The eval suite covers that second class.

---

## ADR-007 — Replacing the supplied read-only role

**Context.** The brief ships `infra/readonly-role.yaml`, invites us to change
it, and asks us to say why if we do. Its evaluation criteria ask whether we
understand "what 'read-only' really means". The original grants the AWS-managed
`ReadOnlyAccess` policy to any principal in dave.io's account.

**Decision.** Replaced. The original is kept as
`infra/readonly-role.original.yaml` for comparison. Three changes, all
narrowing:

**1. `ReadOnlyAccess` → `SecurityAudit` + `ViewOnlyAccess` + an explicit Deny.**

`ReadOnlyAccess` grants around 7,000 actions, including data-plane reads:
`s3:GetObject`, `dynamodb:GetItem`, `ssm:GetParameter`,
`secretsmanager:GetSecretValue`, `kinesis:GetRecords`, and `lambda:GetFunction`
— which returns a presigned URL to the function's source code.

An inventory product needs to know a bucket exists, how it is configured, and
who can reach it. It never needs to read an object out of it. With
`ReadOnlyAccess`, a compromise of dave.io's platform account becomes a
compromise of every customer's *data*, not merely their inventory. That is a
materially larger blast radius for capability the product does not use.

`sqs:ReceiveMessage` is worth singling out because it is not read-only even
literally: receiving a message starts its visibility timeout and can hide it
from the consumer that should have processed it. A scanner holding that
permission can disrupt a production queue by accident — which would breach the
brief's hard rule through a permission nobody thought of as a write.

The explicit `Deny` is the load-bearing part. Deny cannot be overridden by any
Allow, including one a future AWS update to a managed policy might introduce.
It turns "dave.io can see your infrastructure but not your data" from a
statement about which policies we attached today into a property of the role.

**2. Trust scoped to the scanner role, not `:root`.**

`Principal: arn:aws:iam::<account>:root` does not mean the root user; it
delegates to IAM in that account, so **every** principal there — every role,
user and CI job — may assume the customer role if its own policy allows it.
The ExternalId condition addresses the confused-deputy problem, which is a
different threat: it stops a third party inducing dave.io to use its access,
but places no limit on which internal principal does so. Naming the scanner
role means a compromise of an unrelated dave.io workload does not reach
customer accounts.

**3. `sts:SourceIdentity` for attribution.**

Lets the customer's own CloudTrail record which dave.io operator or system
triggered a scan, immutably for the session's life. A customer granting a
third party standing read access into their account should not have to take
our word for who did what.

**Cost.** `SecurityAudit` + `ViewOnlyAccess` do not cover quite everything:
`s3:GetBucketPolicyStatus`, the Resource Explorer calls, and the Cost Explorer
and CloudWatch reads that better idle-detection would need are added
explicitly. Enumerating them is the point — the permission set stays auditable,
and adding a capability to the scanner requires a visible change here.

There is also a real operational cost: this template is more work to deploy
than "attach ReadOnlyAccess", and every new AWS service the scanner supports
may need a line added. That is the right direction for the friction to run.

---

## ADR-008 — Two tiers of evaluation

**Context.** The brief asks how we know the agent's answers are right, and how
we would know if a change made them worse. A single end-to-end suite answers
neither well: it needs an API key, it is slow and non-deterministic, and when
it fails it does not say whether the data or the reasoning was wrong.

**Decision.** Two suites that fail for different reasons.

**Tier 1 — ground truth over the data** (`src/evals/groundTruth.test.ts`).
Seeds the mock account, runs a real scan, and asserts the result against the
hand-written answer key in `topology.ts`. No model, no API key, ~2 seconds.
It checks that the bucket with a neutralised policy is *not* public, that the
inline-admin role *is* admin, that the private database is reachable by both
expected chains, and that the publicly-flagged database is reachable by none.

**Tier 2 — answer quality** (`npm run evals`). Fifteen cases run against the
live agent, scored on the ARNs the answer cites, with precision and recall.
Each case asserts what must be cited, what must **not** be (the traps), and
which tools should have been chosen. Any unsupported citation fails the case
outright.

**Why the split.** Tier 1 runs in CI on every commit and catches the failure
that matters most: an analyser regression that makes the agent confidently
wrong through no fault of its own. Tier 2 catches prompt and tool-choice
regressions, costs money, and needs a key.

It also makes failures diagnosable. If tier 1 passes and tier 2 fails, the
data is right and the agent misused it — a prompt or tool-description problem.
If tier 1 fails, nothing about the agent is worth looking at yet.

**Why score citations rather than text.** Citations are already validated
against what the tools returned, so they are a stronger signal than string
matching, and they are numeric — which is what makes "did this change make it
worse?" answerable rather than a matter of opinion. Precision matters as much
as recall precisely because the mock contains traps: an answer that names every
bucket achieves perfect recall and is useless.

**Cost.** Grading on citations misses answers that cite the right resources and
describe them wrongly. `mustMention` / `mustNotMention` patterns cover the
cases where that has teeth — the agent must say `analytics-db` is *not*
exposed, not merely mention it.
