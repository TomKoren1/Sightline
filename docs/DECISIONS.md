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

**Context.** A real AWS account or a mock were both options. A mock had to be
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
  interesting question here.
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

**Context.** Both databases were on the table — either, both,
or neither. Using both because both were offered is not a reason.

**Decision.** Both, with a strict hierarchy: **Postgres is authoritative,
Neo4j is a rebuildable projection of it.**

**Why Neo4j at all.** The questions this answers are overwhelmingly about
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

- _Safety._ The one hard rule is that the agent must never change
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
five design questions the README answers.

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

**Context.** The starting point was `infra/readonly-role.original.yaml`, with an invitation to change
it, and asks us to say why if we do. Its evaluation criteria ask whether we
understand "what 'read-only' really means". The original grants the AWS-managed
`ReadOnlyAccess` policy to any principal in Sightline's account.

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
`ReadOnlyAccess`, a compromise of Sightline's platform account becomes a
compromise of every customer's _data_, not merely their inventory. That is a
materially larger blast radius for capability the product does not use.

`sqs:ReceiveMessage` is worth singling out because it is not read-only even
literally: receiving a message starts its visibility timeout and can hide it
from the consumer that should have processed it. A scanner holding that
permission can disrupt a production queue by accident — which would breach the
read-only rule through a permission nobody thought of as a write.

The explicit `Deny` is the load-bearing part. Deny cannot be overridden by any
Allow, including one a future AWS update to a managed policy might introduce.
It turns "Sightline can see your infrastructure but not your data" from a
statement about which policies we attached today into a property of the role.

**2. Trust scoped to the scanner role, not `:root`.**

`Principal: arn:aws:iam::<account>:root` does not mean the root user; it
delegates to IAM in that account, so **every** principal there — every role,
user and CI job — may assume the customer role if its own policy allows it.
The ExternalId condition addresses the confused-deputy problem, which is a
different threat: it stops a third party inducing Sightline to use its access,
but places no limit on which internal principal does so. Naming the scanner
role means a compromise of an unrelated Sightline workload does not reach
customer accounts.

**3. `sts:SourceIdentity` for attribution.**

Lets the customer's own CloudTrail record which Sightline operator or system
triggered a scan, immutably for the session's life and across chained roles. A
customer granting a third party standing read access into their account should
not have to take our word for who did what.

`RoleSessionName` does not achieve this: the caller picks it per-assume and it is
replaced at every hop of a role chain, so it attributes nothing the customer can
rely on. The trust policy therefore _requires_ SourceIdentity via a `Null`
condition rather than merely permitting it — permitting it alone lets a caller
omit it and quietly lose the attribution the policy appears to guarantee — and
constrains the prefix to `sightline-`. Hyphen, not colon: AWS restricts
SourceIdentity to alphanumerics, underscore and `+=,.@-`, so the `sightline:*` this
originally specified was a pattern no legal value could satisfy (engineering log
#42).

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

**Context.** "How do we know the agent's answers are right, and how
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

**Tier 2 — answer quality** (`npm run evals`). Twenty-one cases run against the
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

**A drifted account is not a broken one.** `npm run drift` deliberately breaks
some tier-1 checks — a bucket really does become public — so each failure is
attributed to the drift or not, from a map declared beside the mutations that
cause it. The panel softens only when every failure is accounted for; one
unexplained failure keeps it red. The previous note said "some are expected to
fail", which excused the whole panel including a genuine regression (engineering
log #41).

**An outage is not a regression.** A case that never reached the model is
recorded as `errored`, not as a failure: it is excluded from `meanF1`, scores are
stated out of the cases that actually ran, and a run that did not complete is
**not written to `eval_runs`** — so an incomplete run cannot replace the baseline
the next run is compared against. A terminal error (spend cap, quota, rejected
key) aborts the run rather than repeating itself across every remaining case, and
exits `2` where a quality regression exits `1`, because the two need different
responses: repeat the measurement, versus investigate the change.

This is here because the alternative was not hypothetical. Four cases erroring
after a spend cap was reached reported **"17/21 cases passed, mean F1 0.81"** in
the Trust panel. Every number was arithmetically correct and the conclusion a
reader draws from them — the agent got worse — was false (engineering log #40).

**Cost.** Grading on citations misses answers that cite the right resources and
describe them wrongly. `mustMention` / `mustNotMention` patterns cover the
cases where that has teeth — the agent must say `analytics-db` is _not_
exposed, not merely mention it.

---

## ADR-009 — The read-only refusal is enforced in code, not prompted

**Context.** The one hard rule is that the agent must never change
anything. Structurally it cannot: no tool can express a mutation, and the IAM
role has no write permissions. But a user only learns that from what an answer
_says_, and the eval suite caught the agent answering "please delete this
volume" with the volume's details and a CLI command — safe, useful, and silent
on the fact that Sightline holds no ability to touch their account.

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
their production infrastructure, and Sightline's proposition is an AI system with
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

## ADR-015 — Onboarding is automated by a host script, not by a form in the product

**Context.** ADR-010 decided the UI guides onboarding rather than performing it,
and the reason still holds: this API has no authentication, so a form that
accepted a role ARN and an external id would be an open endpoint that assumes a
role into somebody's AWS account and persists a value the role template calls a
credential.

What that left was a reader hand-editing `.env` and copying a CloudFormation
command. Tested on a second machine, that flow produced four separate defects
before it worked — a placeholder pasted whole, credentials not reaching the
container, a generic error that named none of its three causes, and a trust policy
condition that could never match. Every one was a product bug rather than a
mistake by the person following the instructions.

**The constraint that decides it.** A form could not have fixed the expensive
half. The API runs in a container with no AWS CLI, no permission to create an IAM
role, and no access to the `.env` on the host. A form could have collected a role
ARN into a database; the reader would still have run the CloudFormation command by
hand, which is where the failures were.

A script runs where the capability already is: the user's AWS CLI, their SSO
session and named profiles, their `.env`, and Docker.

**Decision.** `npm run setup`. It resolves the identity to trust, converts the
session ARN to one a trust policy can name, deploys the stack, reads `RoleArn`
back out of the stack **outputs** rather than having anyone copy it, writes `.env`,
adds the profile mount when the API is containerised, recreates the container, and
runs the connection test. `--mock`, `--dry-run`, `--disconnect`, `--profile`,
`--region`, `--anthropic-key`, `--yes`.

ADR-010 is unchanged. There is still no form, still no unauthenticated endpoint
that touches AWS, and the guided steps remain in the UI behind a disclosure — for
a reader who wants to see each one, or who would reasonably rather not run a
script against their own AWS account.

**What makes it safe enough to run against a real account.**

- Nothing writes before the plan is shown and accepted. Confirmations default to
  **no**; `--yes` exists for scripting. `--dry-run` performs read-only AWS calls
  and no mutations at all.
- `.env` is backed up, then rewritten touching only declared keys — checked
  against the produced content by `untouchedKeys()` before the write, not merely
  intended, and refused outright if an edit strays outside the shared allow-list.
- Credentials are never printed: the ExternalId and the LLM key are masked in the
  diff. The script never asks for an access key and **cannot** write one — the
  allow-list excludes them, asserted over the list itself.
- Every AWS call passes an argument vector, never a composed command line, so no
  value a user supplies can become shell syntax.
- Re-running is a no-op, and an ExternalId already in use is reused rather than
  rotated. Deleting anything needs `--disconnect`.

**Why the command lives in one place.** The stack name, role name, ExternalId
prefix and the deploy command itself moved to `@sightline/shared`. The Connection
screen renders it, the script executes it, and the API diagnoses what the reader
ended up with. Three consumers of one definition, with the recipe checked against
the template directly — because the alternative is the failure mode this log
returns to more than any other (#39, #42, #45, #47): two artefacts that must
agree, and nothing checking that they do.

**Cost.** The script needs Node, which the one-command Docker path otherwise does
not. That is an acceptable trade because connecting a real account already needs
the AWS CLI, a larger dependency, and because the demo account — the path a
reviewer uses — needs neither. The alternative, a shell script plus a PowerShell
script, is two implementations of a sequence of confirmations and error parsing,
which is precisely where the cross-platform bugs in this project have lived.

CI cannot test the AWS path, because it has no credentials and faking them would
test the fake. What it does test is the half that must never be wrong: that the
script refuses, explains, and changes nothing when it cannot proceed — and, so
those assertions mean something, that `--mock` really does write and back up.

---

## ADR-016 — Drizzle as the data layer, superseding hand-written SQL

**Context.** The original decision was no ORM: seven tables, eighteen query sites,
and queries whose interesting parts — a self-join on fingerprint, two `NOT EXISTS`
set differences, a batched insert sized against Postgres's parameter cap — are
relational enough that an ORM would have been a layer to argue with rather than a
help.

Reviewed, that read as a legibility problem rather than a correctness one: an
engineer picking up `repository.ts` meets placeholder arithmetic (`$${b + 1}`)
before they meet the domain. The criticism is fair, and it is about the reader
rather than about the code being wrong.

**Decision.** Drizzle, not Prisma.

Drizzle is SQL-shaped, so every query ported roughly one-for-one and the ones
worth reading got shorter: thirty lines of placeholder arithmetic became
`.values(batch.map(...))`, and the diff's self-join became an `alias()` and an
`innerJoin` that says what it does. Prisma would have owned the migration layer
and then handed the three interesting queries back through `$queryRaw` — half
ORM, half raw, which reads worse than consistent raw SQL.

The schema is now TypeScript, in `src/db/schema.ts`, and `drizzle-kit` generates
migrations from it. The server still applies them on boot, so nothing about how
the project starts changed.

**What the ORM found that the driver had hidden.** `pg` returns `any`. Typed
columns immediately surfaced three places where that mattered: `scan_units.status`
and `.service` were being narrowed by a cast rather than by the schema, `derived`
was `any` rather than `DerivedFacts`, and a test fixture carried `kind: "ec2"` —
not a `ResourceKind` at all — behind an `as Resource` that silenced it. None were
live bugs. All were checks that were not happening.

**What stayed as SQL.** The health probe's `SELECT 1`, because it is a liveness
check rather than a question about the domain, and `excluded.*` inside the upsert,
which is the dialect's own word for "the row that was being inserted".

**The cost, and it is the real one.** Introducing migrations to a database that
already holds rows is the awkward part, and the first attempt got it wrong in a way
that passed: see engineering log #53. The baseline migration is hand-edited to be
idempotent _and_ to rename the constraints an older database already carries, so a
migrated database and a fresh one end up with identical catalogues. That
equivalence is asserted on every run by `src/db/adoption.test.ts`, which builds
both and diffs them.

---

## ADR-017 — NestJS, superseding the Fastify route modules

**Context.** The HTTP layer was five `registerXRoutes(app)` functions holding
their handlers inline. That is a clean enough shape, and it was read as the
absence of a backend framework — which in a Node team means NestJS: modules,
controllers, services, dependency injection. Fastify is an HTTP server; it was
never the thing being asked for.

The criticism is about the reader, not the code. Under time pressure an
unfamiliar structure costs more than an untidy familiar one, and a reviewer
arrives knowing where a Nest controller lives.

**Decision.** NestJS on the **Fastify** adapter, not Express. The HTTP behaviour
underneath stays the one this project already had: the SSE endpoints write to
the raw socket, and `maxParamLength: 2048` is a Fastify router setting that a
whole class of IAM ARNs depends on (engineering log #37). Changing the server as
well as the framework would have made every behavioural difference ambiguous.

Six feature modules — `health`, `graph`, `scans`, `chat`, `evals`, `connection`
— each a controller over a service, listed in `app.module.ts`.

**The constraint that shapes every file.** Nest normally infers what to inject
from a constructor parameter's type, which needs `emitDecoratorMetadata`.
esbuild cannot emit it — it requires type information a transpiler does not
have — and esbuild is what both `tsx` and `vitest` use here. Nest does not fail
loudly on that: it injects `undefined`, and the handler throws at request time.

So every injection in this package names its token:

```ts
constructor(@Inject(GraphService) private readonly graph: GraphService) {}
```

The alternative was moving the whole package onto SWC — in the runtime, in the
Docker image, and in the test runner that 406 tests depend on. Three places to
keep in step, to delete one redundant-looking argument per constructor. The
token is the cheaper honesty.

**What the framework actually bought, beyond familiarity.** `scanInProgress` was
a module-level `let` in the route file. It is now `ScanStateService`, and that
is not ceremony: a module-level mutable is shared by everything in the process
with no way to scope it, whereas a provider can be given a narrower lifetime
without touching a caller. It is one of exactly two things standing between this
and multi-tenancy — the other is the cached AWS session — and both now have a
seam.

**What was deliberately not adopted.** `@Sse()`. It serialises an Observable
into its own wire format, and the frontend already parses this one. Both
streaming endpoints take `@Res()` and write to the raw socket exactly as before,
which is what a hand-managed stream wants and what kept the port invisible to
clients.

**The cost.** More files for the same behaviour, decorators, and a DI container
to understand. Worth it for a team; it would not be worth it for a service with
three endpoints.

---

## ADR-018 — The Vercel AI SDK, superseding the hand-written agent loop

**Context.** ADR-005 chose a curated tool library over text-to-Cypher, and the
loop that drove it was written by hand. The argument for writing it was specific
and, I thought, decisive:

> Validating that every ARN in an answer came from a tool result means holding
> the tool results, which means owning the loop.

Reviewed, the absence of a framework was read as not knowing the conventional
option. That is worth taking seriously even where the reasoning was sound,
because an unconventional choice costs the reader time whether or not it was
right — and this one was only half right.

**What the argument got wrong.** Holding the tool results is necessary. Owning
the loop is not how you get it. In the AI SDK a tool's `execute` is _our_
function: the SDK decides when to call it and with what arguments, and the rows
it returns pass through our hands before they reach anything else, including the
model. The ledger records there. No framework callback mediates it, so the
failure the original argument feared — an incomplete ledger flagging a real
resource as invented — is not reachable by the route it feared.

What was genuinely correct in the argument is the _stakes_: a ledger that misses
one tool's output marks a real ARN unsupported, the user sees the product cry
wolf once, and the warnings stop being read. That is why the property is now
asserted rather than reasoned about — see below.

**Decision.** `ai` with `@ai-sdk/anthropic`. `streamText`, `stopWhen:
stepCountIs(8)`, tools built from the existing `TOOL_DEFINITIONS` and handed over
through `jsonSchema()` so not one of the sixteen schemas was rewritten. The
direct `@anthropic-ai/sdk` dependency is gone; the tool-definition type is
declared in `tools.ts`, because the tool boundary should not be shaped by
whichever client happens to deliver it.

**What is unchanged, deliberately.** `CitationTracker`, `validateCitations`,
`enforceReadOnlyNotice`, the sixteen tools, the Cypher write-guard, and the
events the UI renders. The guard still runs on the single exit path after the
model has finished, so nothing reaches a user without passing it.

**The test that makes this a decision rather than a hope.**
`agent/ledger.test.ts` drives `ask()` with a scripted model that does what no
prompt reliably produces: calls a tool, then answers naming a resource that tool
never returned. It asserts the invented ARN is flagged and a real one is not, and
it runs with no network and no API key, so it is in the suite on every commit.
Verified by breaking it four ways — never record, record without the ARNs, skip
the read-only guard, drop the trace — each failing its own assertion.

**What I would still hand-write.** The loop is now worth about ten lines of
configuration, which is the correct amount of code to own for something that
standard. If this needed sub-agents, planning, or work that outlives a context
window, that is where a heavier framework starts earning its keep; it does not
here, and that was never the question.

---

---

## ADR-019 — Type-aware ESLint, and type-checking the code that was outside every project

**Context.** `npm run lint` was `prettier --check .`, and nothing else. That
checks whether the code is _formatted_; it says nothing about whether it is
_correct_. A strict TypeScript monorepo with no linter will still compile a
floating promise, a `catch` that discards an error, a dead import, and an
`async` function with nothing to await — and all four pass review and pass CI.

Separately, `npm run typecheck` runs `--workspaces`. `infra/` is not a
workspace, so its six guard tests — including the ones asserting the Dockerfile
copies `scripts/` and that the workflows name paths that exist — were
type-checked by nothing at all. vitest transpiles them with esbuild, which
strips types without reading them, so they could have been type-broken and
still have run green.

**Decision.** ESLint 9 flat config with `typescript-eslint`, including the
**type-aware** rule sets, plus a `tsconfig.tools.json` covering `infra/`,
`scripts/` and the root config files, wired into `npm run typecheck`.

The type-aware rules are the reason to bother. `no-floating-promises`,
`no-misused-promises` and `no-base-to-string` cannot work from syntax alone —
they need to know that an expression is a `Promise`, or that a value's runtime
type has no useful `toString`. Those are the mistakes that have actually cost
time in this repository. The price is that every linted file must belong to a
TypeScript project, which is the same constraint that closed the `infra/` hole,
so the two halves of this decision are really one.

**What the first run found,** in 215 problems over 45 files:

- **A shutdown handler that could not shut down.** `process.on(signal, async
() => …)` passes a promise-returning function where a `void` return is
  expected. A failure in any of the three `close()` calls surfaced as an
  unhandled rejection, and because nothing then reached `process.exit`, the
  process hung instead of exiting. Now the handler is synchronous, the async
  work is launched inside it, and a failed shutdown exits non-zero — which is
  what a container's stop timeout is waiting for.
- **`[object Object]` in fourteen places.** `String(bag["key"])` over a
  `Record<string, unknown>` is one object away from rendering nothing a reader
  can use. One of the six sites in the resource detail panel was already doing
  it correctly, inline; that correct version became `asText` in
  `packages/shared`.
- **The same idiom spelled five ways.** `err instanceof Error ? err.message :
String(err)` appeared 22 times, and three of them had lost the `String(…)` —
  so those three interpolated a raw `unknown` and printed `[object Object]` for
  anything thrown that was not an `Error`. Now one `errorMessage` helper, which
  renders a thrown object as JSON rather than as nothing.
- **Seven dead imports**, one of them a `template` in
  `infra/connectionGuide.test.ts` left behind when the assertion that used it
  moved somewhere stronger. Dead code in a test is worse than dead code
  anywhere else: it reads as coverage.

**What was deliberately turned off,** because a gate nobody can pass is a gate
people delete:

- **`dot-notation`.** 106 of the 215 were this rule objecting to
  `properties["publiclyAccessible"]`. It cannot tell an index signature from a
  property access, and with `noUncheckedIndexedAccess` on, brackets are the
  form that says "this key may not be there".
- **`prefer-nullish-coalescing` over strings.** Every string case flagged was a
  deliberate chain: `e.stderr || e.message || ""` wants an _empty_ stderr to
  fall through, and `??` would keep the empty string and hide the only text
  there was. ENOENT has exactly that shape.
- **The `no-unsafe-*` family is `warn`, not `error`.** They are load-bearing at
  the AWS SDK and Neo4j boundaries, where responses are genuinely dynamic.
  Making them errors would buy a suppression comment on every boundary.

**The cost.** A lint step that needs `npm ci` before it can run, because the
type-aware rules need the tsconfigs; roughly fifteen seconds in CI. And a
config file with opinions in it, each of which is now a thing to argue with —
which is why each one above says what it cost to turn off rather than just
that it is off.
