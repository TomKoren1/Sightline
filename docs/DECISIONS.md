# Architecture decision records

Each record states the problem, the options that were genuinely considered, the
decision, and what it costs. Recorded at the time the decision was made.

---

## ADR-001 — TypeScript across the whole repo

**Context.** The stack was unconstrained. The work spans an AWS scanner, two
databases, an LLM agent and a React graph UI.

**Options.**

- _Python backend, TypeScript frontend._ Best-in-class AWS tooling (`boto3`,
  `moto` in-process), and the richest agent-framework ecosystem. Costs a second
  toolchain, a second test runner, and a language boundary through which the
  domain model has to be restated.
- _TypeScript throughout._ One model definition shared by scanner, API and UI;
  one test runner; one CI pipeline.

**Decision.** TypeScript throughout.

**Why.** The domain model is the centre of this project — `Resource`,
`Relationship`, `ScanUnit`, the agent's wire types. Defining it once in
`packages/shared` and importing the _same types_ into the scanner, the API and
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

- _A real AWS account._ Maximum fidelity, but reviewers cannot run it, costs
  money, and the interesting security topology would have to be built by hand
  in someone's account.
- _Hand-written fixtures behind a fake client._ Fast and fully controlled, but
  it deletes the entire AWS integration — credentials, paginators, error
  handling — which is a third of what is being assessed.
- _LocalStack (community)._ Real AWS API surface. **Cannot do RDS** in the
  community edition, and the production database is the centre of the most
  interesting question in the brief.
- _moto in server mode._ Real AWS API over HTTP. Verified by probe to support
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
_relationships_, and one of them — "what can reach the production RDS
instance?" — is a variable-length path query over security group references.
In Cypher that is one `MATCH` with a `*1..n` hop. In SQL it is a recursive CTE
over a junction table that nobody on the team will enjoy maintaining. The graph
is not decoration; it is the shape of the problem.

**Why Postgres too.** Three things fit badly in a graph:

1. _Scan history._ "What changed since the last scan?" needs immutable
   snapshots over time, not a mutable current-state graph.
2. _Partial failure._ Per-`(service, region)` outcomes, error codes, durations
   and API-call counts are a plain relational fact table.
3. _Agent traces._ Conversations, tool calls and eval results are relational
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
of its managed and inline policies grants `*` on `*` — which no policy _name_
reliably indicates.

**Options.**

- _Give the model the raw JSON and let it reason._ Flexible, and wrong often
  enough to be dangerous. A DevOps engineer acting on "this bucket is private"
  needs that to be a fact, not a generation.
- _Compute the facts deterministically during ingest; let the model select,
  combine and explain them._

**Decision.** The second. Analysers in the ingest pipeline compute
`isPublic`, `isAdmin`, `isIdle` and the derived `CAN_REACH` edges, each paired
with a human-readable `reason` recording the evidence.

**Why.** It moves the part that must be correct into code that can be unit
tested against a known topology, and leaves the model doing what it is actually
good at: picking the right query, joining results, and explaining them in
English. It also makes wrong answers _debuggable_ — a bad verdict is a failing
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

- _Safety._ The brief's one hard rule is that the agent must never change
  anything. A curated tool cannot express a mutation.
- _Correctness._ Hand-written Cypher for "find every path from the internet to
  this resource" is reviewable, testable, and identical on every run.
- _Cost and latency._ A tool call returns rows; text-to-Cypher tends to return
  a schema, a failed query, an error, and a retry.
- _Auditability._ Every tool records the exact query it ran and the ARNs it
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

**Cost.** It catches invented _identifiers_, not invented _relationships between
real identifiers_. The eval suite covers that second class.

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
compromise of every customer's _data_, not merely their inventory. That is a
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
It checks that the bucket with a neutralised policy is _not_ public, that the
inline-admin role _is_ admin, that the private database is reachable by both
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
cases where that has teeth — the agent must say `analytics-db` is _not_
exposed, not merely mention it.

---

## ADR-009 — The read-only refusal is enforced in code, not prompted

**Context.** The brief's one hard rule is that the agent must never change
anything. Structurally it cannot: no tool can express a mutation, and the IAM
role has no write permissions. But a user only learns that from what an answer
_says_, and the eval suite caught the agent answering "please delete this
volume" with the volume's details and a CLI command — safe, useful, and silent
on the fact that dave.io holds no ability to touch their account.

**Options.**

- _Prompt harder._ Tried three times: stating the requirement, stating it
  emphatically with explicit anti-patterns, and reordering the prompt after
  discovering the Style rules were competing with it ("do not pad with caveats"
  was being applied to the refusal). None held. Engineering log #15 has the
  detail.
- _Refuse to answer change requests at all._ Guarantees the outcome and makes
  the product worse. The model's answer — confirming the resource, flagging
  that it was tagged `production`, offering a snapshot first — is exactly what a
  DevOps engineer wants.
- _Enforce the statement in code, keep the answer._

**Decision.** The third. `readOnlyGuard.ts` detects a mutation request directed
at the agent, checks whether the answer already declines, and prepends an
explicit notice only when it does not.

**Why.** It is the same argument as ADR-004, applied to safety instead of
security analysis: the part that must be true is computed deterministically, and
the model is left doing what it is reliably good at. It also makes the property
testable — eight unit tests, rather than a prompt whose compliance can only be
sampled.

The general principle, which is worth stating because it recurs: prompting is
the right tool for tone, emphasis and preference; it is the wrong tool for a
guarantee. The signal that you have crossed that line is finding yourself
saying the same thing louder.

**Cost.** Two. The detector is a heuristic over imperative verbs and request
markers, so it will miss unusual phrasings — it is a second line of defence
behind a prompt that usually works, not a parser. And when it fires on an
answer that declined in wording the detector did not recognise, the notice is
mildly redundant. Both failure directions are harmless, which is why a
conservative heuristic is acceptable here; the reverse trade-off would not be.

---

## ADR-010 — Onboarding is guided in the UI, not performed by it

**Context.** The product's real first step is connecting a customer's AWS
account. The obvious feature is a form: paste a role ARN and an external id,
press connect.

**The constraint that decides it.** This API has no authentication. Every
endpoint is open. A form like that would therefore be an unauthenticated
endpoint that assumes a role into somebody's AWS account, and it would persist a
value that the role template itself calls a credential, in plaintext, behind
nothing.

**Decision.** The UI guides onboarding and does not perform it. The server
generates a fresh external id, renders the exact CloudFormation command with
parameters filled in, explains what access the role grants and why, and tests
the connection that is already configured — `AssumeRole` followed by
`GetCallerIdentity`, two read-only calls. Putting the role ARN into
configuration stays a deliberate act by an operator with host access.

**Why this is the better answer and not the lazy one.** It delivers what the
screen is actually for: a customer can see what they are granting, get the
values they need, run one command, and find out immediately whether it worked —
with a diagnosis rather than a stack trace when it did not. The step that is
omitted is the one that would require authentication, tenant isolation and
encrypted secret storage to do responsibly. Building it without those would make
the demo look more complete and the product less defensible, and a reviewer
asking "would you deploy this?" deserves a yes.

The screen says so, in step 4, rather than leaving the omission to be inferred.
A customer granting a third party standing access into their account is
reasonably interested in how that access is constrained.

**Cost.** Connecting an account is not a single click, and a multi-tenant
version would have to build the form eventually — behind auth. The diagnosis
logic in the connection test is where most of the value landed, and it carries
over unchanged.

---

## ADR-011 — Evaluation results are shown in the product

**Context.** The eval suite is the strongest evidence this project has that its
answers can be trusted, and it was invisible: a reviewer had to read the README,
obtain an API key and run a CLI to see any of it.

**Decision.** A Trust panel in the UI, presenting the two tiers as different
kinds of evidence. Data checks run on demand — no model, no key, milliseconds —
so they are live evidence about the inventory currently on screen. Agent evals
are read from `eval_runs` and displayed, because they cost money and a button
that spends it per click is a bad button.

**Why it belongs in the product rather than only in CI.** "How much should I
trust this?" is a real question from someone about to act on an answer about
their production infrastructure, and dave.io's proposition is an AI system with
standing access to a customer's account. Answering it in the product is part of
the product, not documentation.

**The consequence that needed handling.** The data checks assert properties of
the seeded fixture, and `npm run drift` deliberately changes the account — so
after drift, some checks are _supposed_ to fail. Presented naively that reads as
a broken system. The endpoint therefore detects a drifted account and says so,
and the panel shows amber with an explanation rather than red. A panel that
cries wolf teaches people to ignore it, which is the same failure the citation
validator had (engineering log #12) and worth recognising as a pattern: any
indicator whose false positives are not handled will be ignored, and then it is
worse than absent.

**Cost.** The checks are meaningful only against the mock, so the endpoint
refuses when `AWS_MODE=real` rather than showing a real customer assertions
about a fictional account. A production version would need per-customer
expectations, which is a different and larger feature.

---

## ADR-012 — "Public" and "unprotected" are separate verdicts

**Context.** A user created an S3 bucket, switched all four Block Public Access
settings off, expected it to be reported as public, and it was not. Reasonable
confusion — and the tool was right: the bucket had no policy and an owner-only
ACL, and an anonymous request returned 403.

**The distinction.** Turning Block Public Access off grants nobody anything. It
removes the setting that would neutralise a permissive policy _if one were ever
added_. A bucket can be unprotected and entirely private, and that is the common
case.

**The trap on both sides.** Reporting such a bucket as public would be a false
positive on the most consequential verdict this project makes, and a
security tool that cries wolf about exposure gets muted. Reporting nothing left
a real posture finding invisible — Block Public Access being off is something
AWS Security Hub flags, and something a DevOps engineer wants to know.

**Decision.** Two independent derived facts. `isPublic` means anonymous access
is granted **now**. `isUnprotected` means nothing would stop it being granted.
They are computed together, surfaced in separate tabs, and the agent has a
separate tool for each, whose description tells it never to describe an
unprotected bucket as public.

**Why this is the interesting case.** Almost every security tool gets asked to
collapse a spectrum into a boolean, and the temptation is to widen the boolean
until it catches everything anyone might care about. That produces alert
fatigue, which is how the true positives stop being read — the same failure the
citation validator had with Markdown backticks (engineering log #12) and the
Trust panel had with drift (ADR-011). Three separate features, one lesson:
**an indicator is only as useful as its false-positive rate, and the fix is
usually another indicator rather than a wider one.**

**Cost.** One more concept for a user to hold, and a sixth tab. The prompt
carries an explicit paragraph on the distinction because the model would
otherwise conflate them too — it is a genuinely easy mistake.

---

## ADR-013 — The account toggle switches at runtime and never writes .env

**Context.** Demonstrating this means showing the seeded fixture, where the
interesting findings live; using it means showing a real account. Restarting
the backend to move between them is friction in a demo and confusing in use.

**Decision.** A toggle in the header switches the active connection at runtime.
`.env` is never rewritten.

**Why not persist the choice.** A UI control that silently edits configuration
is a nasty surprise for whoever next reads the file, and being able to return to
a known state by restarting is worth more than remembering the toggle. The UI
shows an "overridden" marker when the toggle and `.env` disagree, so the
divergence is visible rather than mysterious.

**What it required.** `isMock` had to stop being a module-level constant
captured at import, which is what it had always been. It became a function, and
TypeScript then found all nine call sites — except one, in a test, where
`!isMock` on a function is valid TypeScript that is always `false`. That
silently disabled the guard stopping the ground-truth suite from scanning a real
account (engineering log #23), and it was caught by the suite failing rather
than by the compiler.

The endpoint override and placeholder credentials are now stripped from
`process.env` **unconditionally** at startup, not only in real mode, and the
mock's endpoint is passed explicitly instead. Otherwise starting in mock mode
would leave a landmine for a later switch to real — the same bug as engineering
log #17, arriving by a different route.

**Cost.** Switching does not rescan, so the graph still shows the previous
account until one runs. The UI says so rather than letting someone read one
account's inventory under another's name.

---

## ADR-014 — Remediation is generated and never applied

**Context.** The product identifies a public bucket, an admin role, an SSH port
open to the world — and then stops. The engineer reading it still has to work
out the exact command, which is the part where mistakes happen: detaching
`AdministratorAccess` from a role whose admin actually comes from an inline
policy, or revoking an ingress rule before adding the replacement and locking
themselves out of the host.

The obvious next step is a **Fix it** button. It is also the one thing this
product must not have.

**Decision.** Every finding carries the exact commands that would resolve it,
what each one might break, and a read-only command to confirm it worked — as
**strings**. There is no endpoint that executes them, no credential with the
permission to, and no plan to add either.

**Why this strengthens the position rather than straining it.** Every other
decision here points the same way: the IAM role has no write permissions and an
explicit Deny on data reads (ADR-007), no agent tool can express a mutation
(ADR-005), and a request to change something is refused in code (ADR-009). A
Fix button would undo all three in one click, and the trade is bad in both
directions — it buys convenience and sells the single property that makes
standing access to a customer's account defensible.

The honest version is also the more useful one. The person who knows whether
`northwind-public-assets` is a mistake or a deliberate CDN origin is the one at
the keyboard, not the scanner. So the product's job is to remove the tedious and
error-prone part — working out the precise command — and leave the judgement
where the knowledge is.

**Computed, not generated.** The commands come from the same evidence as the
verdict, by the argument in ADR-004. A model asked to write
`aws s3api put-public-access-block` will usually produce something right, and
"usually" is not a property you want in a command someone pastes into
production. More concretely: the fixture contains a role whose admin comes from
an inline policy called `legacy-deploy-inline`, and a model reaching for the
obvious `detach-role-policy --policy-arn .../AdministratorAccess` would emit a
command that runs cleanly and fixes nothing. The generator reads which policy
actually grants `*:*` and targets that one. The system prompt tells the agent to
quote the result verbatim rather than compose its own.

**`caution` is a required field.** Not optional, not a nicety. A remediation
without a stated blast radius is a trap, and the most dangerous output this
feature could produce is a confident one-liner that takes a public asset host
offline or strips the permissions from a role a deployment pipeline depends on.
Where the resource is used by something, the caution names it. Where the finding
is posture rather than exposure, it says so — re-enabling Block Public Access on
a bucket nobody can reach is rated **low**, because no anonymous access exists to
lose, and rating it alongside a genuinely public bucket would teach people to
ignore the rating. That is ADR-012 carried to the last step.

**Ordering, too.** The caution renders _above_ the copy button. Below it, it is
read second, and by then the command is already on the clipboard.

**Consequences.** Someone will ask for the Fix button, and the answer is a
product decision rather than a backlog item: a version that applies changes needs
a different trust model — scoped write permissions per action, an approval
workflow, an audit trail the customer controls, and a rollback path — and that
is a different product, not a checkbox. Saying so is a better answer than
building it badly.

The generators also need maintaining alongside the analysers: a new verdict with
no remediation is a finding that dead-ends. That is a real cost, and the reason
the contract tests assert that every remediation has a caution and a read-only
verify command rather than trusting each generator to remember.

---

## ADR-015 — Hosted mode removes capabilities rather than guarding them

**Context.** Everything in this project so far assumes one operator, one AWS
account and one graph. The hosted service breaks all three assumptions at once,
and several capabilities that are harmless under the old assumptions become
dangerous under the new ones:

- the **mock account** is a development fixture with no meaning for a tenant;
- the **runtime mode toggle** is process-wide, so on a shared process it would
  be one tenant switching an account out from under every other;
- the **endpoint override** exists so the scanner can talk to moto, and it
  redirects _signed_ AWS calls — in a service that assumes roles into customer
  accounts, an attacker-supplied endpoint is an attacker-supplied AWS;
- **static AWS keys in the environment** are how a developer points the scanner
  at their own account; the hosted platform identity comes from the pod.

**Decision.** A `DEPLOYMENT_MODE` of `self-hosted` (the default, and what the
graded project is) or `hosted`. In hosted mode these capabilities do not exist:
the process refuses to start if any of them is configured, and the code paths
that would use them are gated independently.

**Why refuse at startup rather than warn.** Each of these is a configuration
mistake that produces a working system with a silently wrong security property.
A warning is read once, at a moment when the operator is looking at something
else. `assertHostedInvariants()` throws before a request can arrive, and reports
_every_ problem at once, because one restart per problem is a bad way to learn
about three.

**Why it is a pure function.** `hostedInvariantViolations(env)` takes an
environment and returns reasons. That makes each invariant testable directly
rather than by launching a process and reading its exit code, and the test suite
asserts both halves: that hosted mode refuses each one, and that **self-hosted
mode says nothing at all** — because a guard that accidentally fired everywhere
would break the demo, the graders' clone and every existing test, while looking
like success from a green hosted assertion.

**Three layers on the endpoint specifically.** `activeConnection()` already
returns no endpoint in real mode; hosted mode cannot reach mock mode at all; and
`effectiveEndpoint()` returns null in hosted mode regardless. The first two are
about configuration, the third is about the value actually handed to the SDK.
The failure it prevents is signed requests sent to somebody else's server, which
is worth three cheap layers.

---

## ADR-016 — The agent's raw-Cypher escape hatch is disabled in hosted mode

**Context.** `graph_query` lets the model ask something the sixteen curated
tools cannot express. It is guarded twice: `cypherGuard.ts` rejects write
clauses lexically after stripping strings and comments, and the query runs
inside a Neo4j read transaction that rejects writes on its own (ADR-005).

In the hosted service, tenants share one Neo4j database — Community edition has
exactly one — with isolation enforced by a `tenantId` predicate on every query
(ADR-017).

**Decision.** In hosted mode the tool is not offered and, independently, the
dispatch refuses it. Self-hosted keeps it unchanged.

**Why the existing guards do not cover this.** They defend against _writes_.
Neither knows _whose_ data a read touches. With one tenant that distinction does
not exist, because there is only one account in the graph. With many, an
unfiltered `MATCH (r:Resource) RETURN r` is a cross-tenant read — and it is not
a write, so both existing layers pass it, correctly, having been asked a
different question.

**The alternative, and why it was rejected.** A rewriter could parse the model's
Cypher and force a `tenantId` predicate onto every `MATCH`. That is a third
layer whose correctness depends on handling every Cypher shape — `UNION`,
`CALL {}`, pattern comprehensions, subqueries — and whose failure mode is
silent, cross-customer, and discovered by the customer. Removing the capability
has no failure mode at all.

**Consistency.** This is the argument this project already makes about mutation:
the agent cannot change anything because no tool _expresses_ a change, not
because something catches it afterwards (ADR-005, ADR-009). A capability that
cannot be made safe is removed, and the Trust panel says so rather than leaving
a tenant to discover a tool that answers "disabled".

**Gated in two places on purpose.** The tool list is filtered _and_ the dispatch
refuses. A model can call a tool it was never offered — from a replayed
conversation, or because the name appears in the prompt — so the list is a
suggestion and the dispatch is the gate. Each is tested by deleting the other.

---

## ADR-017 — A single-tenant deployment is one tenant that always exists

**Context.** The hosted service needs tenancy; the self-hosted project must keep
working exactly as it does. The obvious approach — a tenant id that is optional,
or a "single-tenant mode" that skips the scoping — produces a codebase with two
paths through every query, one of which is only exercised in production.

**Decision.** There is no unscoped path. `schema.sql` inserts a default tenant
with a fixed uuid, the self-hosted product passes it everywhere, and the hosted
service passes one resolved from the session. Every table holding customer data
has `tenant_id NOT NULL` **with no default**, every repository function takes a
tenant, and every graph query binds `$tenantId`.

**Why no column default.** A default would make an insert that forgets the
tenant succeed, landing the row in whichever tenant the default names — which in
a shared database is somebody else's account. Without one it fails loudly, at
the first test that runs it.

**Why a branded type.** `TenantId` is a branded string, so a plain `string`
cannot be passed where a tenant is required. Adding it turned "did anyone forget
to scope this?" from a code review into eighteen compile errors, each one a call
site that had been reading data without saying whose. That is the only version
of this check that scales.

**Why the graph seam refuses rather than filters.** `readQuery` throws when a
query does not bind `$tenantId`, instead of appending a predicate. A query
written without the predicate is a query whose author did not think about
tenancy; silently correcting it would hide that until the day the correction is
missing.

**Node identity is `(tenantId, arn)`, not `arn`.** An ARN is unique within an
AWS account, not across this database. Two tenants collide immediately on the
synthetic `Internet` node, whose ARN is a constant, and completely if they
connect the same AWS account. Under the original uniqueness constraint the edge
projection matched endpoints by ARN alone, so one tenant's relationships would
attach to another tenant's nodes — not a query bug a filter could fix later, but
an edge that genuinely exists and that every path query would traverse. This is
the failure the behavioural test below actually catches, and it was found by
writing that test rather than by review.

**Three guards, because they fail differently.** Static: every curated query
binds the parameter. Runtime: `readQuery` refuses an unscoped query, and needs
no database to do it. Behavioural: two tenants are projected into one graph,
every curated query runs as one of them, and nothing belonging to the other may
come back. Only the third can catch a query that binds the parameter and still
leaks. Each was verified by breaking the thing it guards and watching the right
test go red.

---

## ADR-018 — Google only, sessions as signed cookies, no auth library

**Context.** The hosted service needs to know who is asking. The options were a
hosted identity provider (Auth0, Clerk), an auth framework, or the protocol.

**Decision.** Google OAuth 2.0 authorization code flow, written against the
protocol. One provider. Sessions are HMAC-signed cookies with no server-side
store.

**Why one provider.** Each additional provider is another consent screen to
keep correct, another set of claims to map, and another way for the same person
to end up with two accounts. Google covers the intended users. GitHub is a
`users.provider` value away if that turns out to be wrong — the schema already
allows it.

**Why no library.** The flow is three URLs and two checks. The checks are the
part worth getting right, and a library performs them somewhere I would have to
go and read anyway to know what it actually verifies. The same reasoning as
ADR-005: the decisions that matter are the ones a dependency would hide.

**Why signed cookies rather than a session store.** Several API replicas behind
one ingress would otherwise need a shared store. The cookie carries two
identifiers and two timestamps — no tokens, no email, nothing of the tenant's —
so there is nothing in it worth stealing beyond the session itself, and that
expires in eight hours. The format is a JWT's shape without a JWT library,
because the parts of JWT that earn a library (algorithm negotiation, key
rotation, third-party verification) are the parts not wanted here. `alg: none`
is impossible when there is no algorithm field.

**What is deliberately not verified.** The id token's RSA signature against
Google's JWKS. The token is not accepted from the browser: it is fetched by
this server, over TLS, directly from `oauth2.googleapis.com`, in exchange for a
code and this service's client secret. Google's documentation says verification
is unnecessary for exactly this case. The claims that still matter are checked —
and `aud` is the one that does: a token minted for a **different** Google
application is genuinely from Google and genuinely signed, and accepting it
would let anyone with their own Google app sign in as anybody here.

**Matching is on the provider subject, never on email.** Google subjects are
stable; email addresses are renamed, reassigned inside a Workspace, and — when
unverified — not evidence of anything. Matching on email is how one person ends
up inside somebody else's account.

**One hook, not per-route middleware.** Authentication is a single
`preHandler`, so a route added later cannot forget it. Routes opt _out_, and
the exemption list is three entries long and readable at a glance: `/auth/*`,
`/api/me`, `/api/health`. The test that matters drives the real app and asserts
every tenant-data route returns 401 without a session — because the question is
not whether `decodeSession` works but whether someone can read an inventory
without signing in.

**`Secure` follows the scheme, not the mode.** A Secure cookie over plain http
is dropped silently, which presents as "signing in does nothing". Tying the
flag to `PUBLIC_BASE_URL` starting with `https://` means a developer testing
the hosted path over `http://<tailnet-ip>` — which, unlike `localhost`, is not
a secure context — gets a working login instead of an invisible failure.

---

## ADR-019 — A tenant's AWS connection is data, not configuration

**Context.** Every version of this project until now read the AWS connection
from the environment: `AWS_TARGET_ROLE_ARN`, `AWS_EXTERNAL_ID`, and a single
cached STS session in a module-level variable. For one operator scanning one
account that is not just adequate, it is the right design — the connection
genuinely is a property of the deployment.

In a hosted service it is a property of the **tenant**, and the difference is
not cosmetic: the first real sign-in showed a brand-new tenant the operator's
own AWS account (engineering log #41).

**Decision.** In hosted mode the connection comes from the tenant's
`connections` row and **never** falls back to configuration. A tenant with no
connection gets an explicit `NO_CONNECTION` refusal, not a default. Credentials
are cached per tenant in a map, with the stampede protection that used to be
global kept per tenant.

**Why a refusal rather than a fallback.** A fallback is indistinguishable from
working. Whoever configured the environment would see their own account and
conclude the product was fine; the failure would surface as a customer reading
somebody else's inventory.

**Why the tenant is a parameter everywhere.** `ec2Client(region, tenantId)`,
`iamClient(tenantId)`, `runScan({ tenantId, ... })`, `CollectorContext.tenantId`.
A client cannot be constructed without naming whose account it will talk to.
This is the same argument as the branded `TenantId` in ADR-017, applied one
layer down: the alternative is ambient state, and ambient state is a value that
is correct when there is one of something and silently wrong when there are
many. Making it a parameter turns "did anyone forget?" into a build error, and
adding it produced exactly the list of places that had been reaching for an
account without saying which.

**The endpoint moved too.** It is carried on the assumed session rather than
read from configuration when a client is built, so one process can serve a
tenant on the demo fixture and a tenant on real AWS simultaneously (ADR-020).

**The account is pinned.** On first successful verification the account id the
role actually reaches is stored, and a later mismatch refuses the scan rather
than recording one account's inventory under another's name — engineering log
#31's failure, arriving through a multi-tenant door.

---

## ADR-020 — The demo account is a tenant's choice, and a different thing from an endpoint override

**Context.** ADR-015 removed the mock account from hosted mode, on the grounds
that a development fixture has no meaning for a tenant and that
`AWS_ENDPOINT_URL` redirects signed AWS calls. Both arguments still hold. But a
hosted product has a use the self-hosted one does not: somebody who has just
signed up wants to see what the thing does **before** deploying a
CloudFormation stack into their own AWS account, and telling them to connect
production first is a bad trade for both sides.

**Decision.** A tenant may switch to the demo account at any time. Two things
make that safe, and they are the whole ADR:

**It is a column on the tenant, not a flag in the process.** `tenants.demo_mode`.
The single-tenant toggle was a module-level variable, which is honest for one
operator and would be a shared surprise for many: one person clicking "Demo"
would change what every other tenant on that process was looking at, and which
AWS account their next scan read.

**The endpoint comes from `DEMO_AWS_ENDPOINT_URL`, not `AWS_ENDPOINT_URL`.**
The banned variable is an SDK-wide override: it redirects every signed call the
process makes, including calls made with credentials assumed inside a
customer's account. The demo variable names a fixture the operator deployed,
applies only to tenants who explicitly asked for the demo, and cannot be
influenced by any tenant. Unset, nobody can switch to a demo at all. Hosted
mode still refuses to start when `AWS_ENDPOINT_URL` is set, unchanged.

**Consequences for the credential layer.** The endpoint stopped being a global
and became a property of an assumed session, carried on `AssumedSession`
alongside the credentials — so one process can serve a tenant on the demo
fixture and a tenant on real AWS at the same moment. Client factories take it
explicitly rather than reading it, for the same reason they take a tenant: an
endpoint that arrives later cannot express "no override", because the SDK stops
resolving regional endpoints itself the moment the option is set.

**What this does not change.** A demo tenant's graph is still their own: the
projection is tenant-scoped, so two tenants both exploring the demo have
separate inventories of the same fixture, and neither can see the other's.

---

## ADR-021 — Metrics carry no tenant, logs do

**Context.** The cluster already runs Prometheus, Grafana and Loki. Connecting
this service to them raises one question that is easy to get wrong and hard to
undo: what may appear in a metric label.

**Decision.** `/metrics` is served unauthenticated and carries **no tenant id,
no ARN, no URL and no error message**. Route labels are Fastify's _pattern_
(`/api/resources/:arn`), status is bucketed to a class, and error labels are
codes (`ThrottlingException`) rather than messages. Per-tenant attribution goes
in the logs instead, which are queryable and access-controlled.

**Why.** Two reasons that point the same way. Prometheus keeps a time series
per label combination, so a tenant id or an ARN does not merely leak — it grows
the series count without bound until the scrape _is_ the outage. And a metrics
endpoint is retained for months and scraped by something that has no session
and cannot be given one: Prometheus. Keeping it free of customer data is what
makes serving it without authentication defensible rather than an oversight.

**What is measured.** Three questions: is it serving (rate, errors, latency),
is the product doing its job (scans, outcomes, duration, queue depth, AWS call
rate), and is anything quietly wrong. The third is the one that needed thought,
because those failures all return 200:

- `partial` is a first-class scan outcome beside `succeeded` and `failed` — a
  scan that lost a region looks perfectly healthy in request metrics;
- failed `(service, region)` units, by AWS service and error code;
- **`daveio_agent_unsupported_citations_total`** — ARNs an answer cited that no
  tool returned. An answer carrying one is a 200 with a fluent paragraph in it,
  so without this counter a regression in grounding is invisible until somebody
  acts on a resource that does not exist (ADR-006).

**Redaction is configuration, not discipline.** Discipline is a property of
whoever writes the next log statement. Pino's `redact` covers the paths these
values travel in, and the test runs pino for real and greps the bytes it
produced — checking the path list against itself would pass for a path that is
spelled wrong or nested one level deeper than expected, which is most of the
ways a redaction list is actually wrong.

**The dashboard is tested.** A Grafana JSON file is something nobody runs, so
it rots the way the README did (engineering log #35): a metric is renamed,
every test still passes, and a panel shows "No data" at the moment someone
needs it. A test asserts that every metric the dashboard queries exists in the
registry, and that the ConfigMap and the file on disk are the same dashboard.
