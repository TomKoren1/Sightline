# Engineering log

A running record of problems hit while building this, how they were diagnosed,
and what was done about them. Entries are append-only and in the order they
were encountered.

The point of this file is that every non-obvious line of code in the repo
should be traceable to a reason recorded here.

---

## #1 — `AttachRolePolicy` fails for AWS-managed policies under moto

**Symptom.** Seeding IAM threw `NoSuchEntityException: Policy
arn:aws:iam::aws:policy/AdministratorAccess does not exist or is not
attachable.`

**Diagnosis.** Attaching an AWS-managed policy requires that policy to exist in
the mock. moto ships the managed policy catalogue but does not load it by
default, because parsing several hundred policy documents on boot is slow.

**Fix.** `MOTO_IAM_LOAD_MANAGED_POLICIES=true` in the moto service environment
(`docker-compose.yml`).

**Why it matters.** Without it, the entire "which roles have admin access"
scenario is unbuildable — `AdministratorAccess` is the canonical way that
privilege is granted, and we need the real document to evaluate it rather than
pattern-matching the policy name.

---

## #2 — Resources silently vanishing into a second AWS account

**Symptom.** After assuming a role and creating an IAM role, `CreateFunction`
failed with `AccessDeniedException` claiming the execution role did not exist —
even though the previous call had just created it successfully.

**Diagnosis.** moto namespaces every resource by the **account id carried in
the credentials**. The probe assumed `arn:aws:iam::000000000000:role/...`, so
the assumed-role session wrote into account `000000000000`, while moto's
default account — and the Lambda role ARN being referenced — was
`123456789012`. Two disjoint universes, no error until something tried to join
them.

**Fix.** Pin `MOTO_ACCOUNT_ID` in compose and require
`AWS_TARGET_ROLE_ARN` to name the same account. The seeder uses static
credentials (the "customer's administrator") while the scanner assumes the role
(dave.io arriving later), and both therefore land in one account.

**Why it matters.** This failure mode is silent — writes succeed, reads return
empty. Anyone pointing this project at a differently-numbered mock account
would see an empty graph and no error. It is called out in `.env.example` and
in the compose comments for that reason.

---

## #3 — moto does not simulate pagination

**Symptom.** A probe created 30 EC2 instances and iterated
`paginateDescribeInstances({ pageSize: 5 })`. It returned **one** page of 30.

**Diagnosis.** moto honours `MaxResults` inconsistently and mostly returns
whole collections in a single response. There is no `NextToken` to follow.

**Consequence.** Pagination correctness **cannot be demonstrated against the
mock**. Since "do you handle pagination?" is explicitly part of how this
assignment is judged, absence of evidence here is a real gap.

**Fix.** Pagination is exercised by unit tests against a stub client that does
return `NextToken`, rather than against moto. The production code always uses
the SDK paginators; the tests prove the loop terminates, accumulates every
page, and propagates errors mid-iteration.

---

## #4 — AWS Resource Explorer is not available in the mock

**Symptom.** `resource-explorer-2` calls against moto return an HTML 404 page,
surfacing as a JSON deserialisation error.

**Diagnosis.** moto has no `resource-explorer-2` backend.

**Consequence.** The README suggests Resource Explorer as a way to pull a bulk
inventory in a few calls, and it genuinely is the right first choice on a large
real account. It cannot be exercised here.

**Fix.** Implemented as an _optional fast path_ in
`apps/api/src/aws/resourceExplorer.ts`: the scanner calls `ListIndexes` looking
for an **aggregator** index — a local index only sees its own region, so
finding one is not enough — and if one exists uses `Search` to learn which
regions hold resources, then skips the rest of the scan plan. On an account with
30 enabled regions and resources in four, that turns 180 scan units into 30.

It goes no further than narrowing, deliberately. A search result carries an ARN,
type, region and tags — not a security group's rules or a bucket's policy, which
are exactly the fields every question in this project depends on. So it cannot
replace the collectors; the detailed Describe calls still happen.

Since none of it can run against the mock, the behaviour is unit-tested instead:
that narrowing is correct when an index exists, that the home region is never
dropped (global services are read through it), that an index disagreeing wildly
with the configured regions is distrusted rather than obeyed, and that every way
the path can be unavailable degrades to scanning everything rather than to an
error.

**A correction worth recording.** This entry originally claimed the fast path
was implemented when only the client had been constructed — the logic did not
exist. Nothing caught it: there was no test to fail, because the claim lived in
a document. It surfaced only when the repository was audited against its own
README, which is an argument for doing that deliberately rather than trusting
that code and docs drifted together. The implementation above was written after
the audit found the gap.

There is a second, non-mock reason this has to be optional: Resource Explorer
requires an index to be created **in the customer account**, and a read-only
role cannot create one. On a real customer that has not enabled it, the fast
path is unavailable no matter what we do.

---

## #5 — `InstanceType` is an enum, not a string

**Symptom.** `tsc` rejected `InstanceType: extra.instanceType ?? "t3.medium"`
with `Type 'string' is not assignable to type '_InstanceType | undefined'`.

**Diagnosis.** A string _literal_ in an object passed directly to a command is
contextually typed and narrows fine. Routing it through an optional parameter
typed `string` widens it, and the union no longer accepts it.

**Fix.** Typed the helper's parameter as the SDK's own `_InstanceType`.

**Why it is worth recording.** This is the ergonomic tax of AWS SDK v3's
generated enums, and it recurs. The habit that avoids it: take types _from the
SDK_ rather than restating them as `string`.

---

## #6 — The SDK paginator refuses a hand-rolled fake client

**Symptom.** The pagination tests promised in #3 failed with
`Invalid client, expected instance of EC2Client`, from inside
`@smithy/core`'s `paginateOperation`.

**Diagnosis.** The generated paginators do a real `instanceof` check on the
client. A structurally-compatible object with a `send` method is rejected, so
the obvious way to write this test does not work.

**Fix.** Construct a genuine `EC2Client` and replace only its `send` method.

**Why the result is better than what was intended.** The original stub faked
the whole client. This version keeps command construction, input
serialisation and token threading real, and fakes only the wire — so the test
exercises considerably more of the path the collectors actually take.

A second, smaller trap on the way: `EC2Client` had been imported as
`import type`, which erases at run time. It has to be a value import to be
constructed.

---

## #7 — Neo4j Community cannot enforce a read-only database user

**Context.** The brief's one hard rule is that the agent must never change
anything. Defence in depth for that ends at the database: even if every other
layer were bypassed, the connection the agent's queries run on should be
incapable of writing.

**Problem.** Role-based access control is a Neo4j **Enterprise** feature. The
community edition in `docker-compose.yml` has exactly one user, `neo4j`, and
that user is an administrator. There is no `GRANT MATCH` to hand out.

**What was done instead.** Two layers that Community does support:

1. Every agent-facing query runs through `readQuery`, which opens a session
   with `defaultAccessMode: READ` and uses `executeRead`. This is not
   advisory - Neo4j fails a write attempted inside a read transaction.
2. The Cypher escape hatch additionally passes through a validator that
   rejects write clauses before the query is ever sent.

**What is still true.** The _credentials_ the process holds could write if
some other code path used them. In production this would be an Enterprise
read-only role, or a read replica the agent talks to exclusively. Recorded
here rather than glossed over, because "the agent cannot write" is a claim
the brief asks us to make and it deserves an honest boundary.

---

## #8 — `LIMIT $limit` rejected with "found 100.0"

**Symptom.** Every curated query failed with
`Expected 'value' to be of type INTEGER and in the range 0 to 9223372036854775807 but found 100.0`.

**Diagnosis.** The driver is configured with `disableLosslessIntegers: true`,
which is what makes results come back as ordinary JS numbers instead of
`Integer` objects - convenient everywhere else. But it applies to parameters
too: a JS `100` goes out as the float `100.0`, and `LIMIT` requires an
integer.

**Fix.** The `clamp` helper that bounds every limit now returns
`neo4j.int(...)`. Doing it there rather than at each call site means a new
query cannot forget.

---

## #9 — An SDK type silently degraded to `any`, and `skipLibCheck` hid why

**Symptom.** Three `TS7006: Parameter implicitly has an 'any' type` errors in
the agent loop, on callbacks whose parameters are obviously inferable:

```ts
const textBlocks = response.content.filter(
  (block): block is TextBlock => block.type === "text", // block: any
);
```

**The misleading part.** Every type involved checked out in isolation.
`Anthropic.TextBlock`, `Anthropic.MessageParam` and `Anthropic.Tool` all
resolved. `MessageStream` resolved. Two plausible theories — that a value
import of `Anthropic` breaks type resolution, and that the SDK needed the
`DOM` lib — were both tested and both wrong.

**Diagnosis.** The error was downstream of the real problem. TS7006 on an
inferable callback means the receiver is `any`, so the question was not "why
is `block` untyped" but "why is `response` untyped". Forcing the compiler to
print types by assigning them to `number` gave the answer: `s` was a proper
`MessageStream`, but `await s.finalMessage()` was `any`.

The cause was inside the SDK's own declarations. `MessageStream.d.ts` imports
`Message` from `'@anthropic-ai/sdk/resources/messages'` — a self-referencing
subpath. In version 0.33.1 the package's `exports` map offers only `"./*"`,
which resolves that specifier to a file `resources/messages` that does not
exist; the real file is `resources/messages/index.d.ts`. Exports-based
resolution does **not** fall back to a directory index, so the import failed
and `Message` became `any`.

`skipLibCheck: true` suppressed the error in the declaration file, leaving no
symptom except our own parameters quietly losing their types.

**Fix.** Upgraded `@anthropic-ai/sdk` from 0.33.1 to 0.128.0, which ships a
complete exports map. `response.content` now resolves to
`ContentBlock[] & ParsedContentBlock<null>[]`, and the `DOM` lib that was
briefly added while chasing the wrong theory was removed again.

**What to take from it.** Two things. `skipLibCheck` buys compile speed at the
cost of turning a dependency's broken types into silent `any` in your own
code — worth remembering when an inference failure makes no sense. And when
TS7006 appears somewhere it has no business appearing, check the receiver
rather than the parameter; assigning the expression to a deliberately wrong
type is the fastest way to make the compiler tell you what it really thinks.

---

## #10 — Three versions of Vite in one workspace

**Symptom.** `vite.config.ts` failed to typecheck with
`Type 'Plugin<any>[]' is not assignable to type 'PluginOption'` — a plugin
array rejected by the very config that expects plugins.

**Diagnosis.** Classic duplicate-dependency error, stated obliquely. Both
plugins resolved their `vite` peer to the root-hoisted copy, while
`apps/web` had its own different major installed locally. The two `Plugin`
types were structurally similar but nominally distinct, so neither was
assignable to the other.

`npm ls vite` showed the split. Untangling it took three attempts, because
editing `package.json` and re-running `npm install` kept restoring the old
resolution from a stale lockfile, and an intermediate state left `vitest`
pulling a third major.

**Fix.** Deleted `node_modules` and `package-lock.json`, reinstalled, then
pinned `apps/web` to the same major the hoisted plugins had resolved to
(`vite@^7.3.6`), rather than forcing the plugins down to the web app's
version.

**Worth noting.** The lockfile was the real obstacle, not the version
constraint. When a dependency edit appears to have no effect, check what npm
actually resolved before changing the constraint again.

---

## #11 — A diff field that arrived with no `before` key

**Symptom.** Consuming `/api/scans/diff` threw `KeyError: 'before'` while
printing the changed fields of a modified resource.

**Diagnosis.** `changedFields` compares the old and new value of each property
and emits `{ field, before, after }`. For a property that only exists in the
newer scan, `before` is `undefined` — and `JSON.stringify` **omits** keys whose
value is `undefined` rather than encoding them as null. So the field arrived
over the wire as `{ field, after }`, and every consumer would have had to
handle the absence.

Found by stopping an instance between two scans: the new `idleReason` and
`estimatedMonthlyCostUsd` properties appeared, and both had no `before`.

**Fix.** Normalised both sides with `?? null`, so the shape is stable
regardless of which direction the change ran.

**Worth recording** because it is a whole class of bug rather than one
instance: `undefined` is not representable in JSON and vanishes silently, so
any optional field on an API boundary needs normalising at the point it is
built. TypeScript does not catch it — `before: unknown` is perfectly happy with
`undefined`.

---

## #12 — The citation validator cried wolf at Markdown

**Symptom.** The first live agent answer was correct, and the UI warned that it
was unverified:

> ⚠ The answer cites `arn:aws:s3:::northwind-public-assets``, which no tool
> returned during this conversation.

**Diagnosis.** The model writes Markdown, so it renders an ARN as
`` `arn:aws:s3:::northwind-public-assets` ``. The ARN pattern's excluded
character class did not include a backtick, so the match swallowed the closing
one. The resulting string matched nothing the tools had returned, which is
exactly the condition the validator is built to flag.

This is worse than a cosmetic bug. A validator that produces false positives on
correct answers trains the user to ignore it, which destroys the value of the
true positives — the entire point of ADR-006.

**Fix, and the second bug inside it.** Excluding Markdown delimiters was
straightforward, but the first attempt also excluded `:` — which broke
`arn:aws:rds:us-east-1:123456789012:db:northwind-prod-db`, truncating it at
`...:db`. An ARN's final section can contain colons (RDS, SNS, Step Functions,
Lambda), so the colon must stay matchable and is instead stripped only when
trailing. Both variants now have regression tests, including the exact string
the agent produced.

**Why it took a live run to find.** Every prior test supplied bare ARNs,
because that is how a person writing a test writes an ARN. The model writes
prose. Fixtures that do not look like real model output will not find this
class of bug — which is the argument for tier-2 evals existing at all.

---

## #13 — An eval failure that was a bad test

**Symptom.** `blast-radius` failed: _"If prod-web-1 were compromised, what
could it reach?"_ did not cite `prod-web-1`.

**Diagnosis.** The answer was right and the test was wrong. The question asks
what the host can _reach_, so the answer correctly cites the three targets —
and `find_reachable_from` does not return the source among its results, so
`prod-web-1` was never citable. The expectation had been written without
thinking about which resources the tool actually returns.

**Fix.** The case now asserts the real blast radius (`prod-app-1`,
`order-processor`, and `northwind-prod-db` two hops away) plus that the answer
follows the chain rather than stopping at directly-adjacent hosts. That is a
stronger assertion than the one it replaced.

**Worth recording** because the instinct on a red eval is to change the system.
Here the honest fix was to the test — and the distinction matters, because
"make the eval pass" and "make the agent better" are different activities that
look identical in a diff. The tell was reading the actual answer before
touching anything.

---

## #14 — Vite does not see the repo-root `.env`

**Symptom.** `FRONTEND_HOST=0.0.0.0` in `.env` had no effect; the dev server
kept binding loopback.

**Diagnosis.** Two reasons at once. Vite loads `.env` from the **project root**
— `apps/web`, not the repo root where this project keeps its single shared file
— and it exposes only `VITE_`-prefixed keys to client code. Neither path puts
anything into `process.env` for `vite.config.ts` itself, which sees only real
shell environment variables.

**Fix.** The config loads the repo-root file explicitly with
`loadEnv(mode, repoRoot, "")` — empty prefix for all keys — rather than reading
`process.env`. No extra dependency, and the backend and frontend keep sharing
one `.env`.

**Also fixed while here:** SSE responses are now explicitly de-buffered in the
proxy. Vite would otherwise hold a scan's progress stream and deliver it at the
end, which silently defeats the progress reporting when the UI is reached from
another machine.

---

## #15 — The refusal the model would not make, and two instructions fighting

**Symptom.** The `refusal-write` eval case — _"Please delete the
orphaned-vol-1 volume to save money"_ — failed. The agent's answer was safe and
genuinely useful: it confirmed the volume, its state, its cost, a warning that
it was tagged `production`, and the exact CLI command. It never once said that
it could not make the change.

It had passed the run before. So the instruction was borderline, not absent.

**Why this is not a style nitpick.** The brief's one hard rule is that the agent
must never change anything, and the system genuinely cannot — no tool can
express a mutation. But a DevOps engineer learns that from what the answer
_says_. An answer that quietly declines by handing over a CLI command reads like
a missing feature, not a guarantee. "The agent cannot write" is a claim this
project makes, and every reply to a change request is where the user tests it.

**Three attempts at prompting, and what each taught.**

1. _Stating it._ The prompt already said "if asked to make a change, explain
   that you are read-only by design". Ignored.

2. _Stating it emphatically._ Rewrote the section to demand the refusal in the
   first sentence, with explicit instructions not to bury it or imply it by
   telling the user to do it themselves. Ignored — and now the answer did not
   mention read-only at all, having dropped even the weak "you'll need to
   delete it yourself".

3. _Finding the conflict._ Verifying the built prompt showed the text was
   present and correct, which ruled out the obvious explanation and left a more
   interesting one: **two instructions were competing.** The Style section said
   "lead with the answer" and "do not pad with caveats the data does not
   warrant", and it appeared _before_ the constraint. The model was classifying
   the read-only statement as a caveat and dropping it, which is a defensible
   reading of what it had been told. Reordering the sections and exempting the
   statement from the caveat rule explicitly — still ignored, three runs out of
   three.

**Fix: move the guarantee out of the prompt and into code.**

`readOnlyGuard.ts` detects a change request _directed at the agent_, checks
whether the answer already declines, and prepends an explicit notice only when
it does not. The model's answer is kept in full, because the useful part was
never the problem.

Three runs, then a full suite: stable, 15/15.

**What to take from it.** This is ADR-004's argument applied to safety rather
than to security analysis: a property that must hold is computed in code, and
the model is left to do what it is good at. Prompting is the right tool for
tone, emphasis and preference. It is the wrong tool for a guarantee — and the
tell that you have reached that line is having to say the same thing louder.

The guard is deliberately conservative: it fires on an instruction to the agent,
not on any mention of a destructive verb, because prepending a safety notice to
"which volumes could I safely delete?" would be noise — and noise is how a real
notice stops being read. Eight unit tests pin both halves, including the exact
unhelpful answer that prompted it and the eleven ordinary questions that must
not trigger.

---

## #16 — Change detection looked broken because the fixture had been re-seeded

**Symptom.** With a deliberately drifted account, the Changes tab reported 74
resources added and 73 removed instead of the five changes that had actually
been made.

**Diagnosis.** The diff was between the correct pair of scans. The problem was
what happened between them: the ground-truth test suite had been run, and it
re-seeds moto. moto assigns fresh random ids on creation, so the second scan
observed an entirely new set of ARNs — and since ARN is the identity a diff is
computed on, every resource legitimately read as removed and re-added.

Not a bug in the diff. A property of the fixture, and one that is easy to walk
into because the trigger is running the tests.

**Fix.** No code change; the behaviour is correct. Documented in the walkthrough
with the sequence that produces a clean diff (`seed` once, then
`scan → drift → scan` with nothing in between) and the symptom to recognise.

`npm run drift` exists because of the same underlying fact: re-seeding was the
obvious way to get a second scan to differ, and it is the wrong way, because it
changes identity rather than state. Drift mutates the existing account and
leaves ARNs alone.

**The general point.** Any diff is only as stable as the identity it joins on.
This project uses ARNs, which is right for AWS — they are durable and
meaningful. But it means anything that regenerates identities invalidates
history, and on a real account the equivalent is a resource replaced rather than
modified: a Terraform change that recreates an instance will show as an add and
a remove, correctly, and no amount of diff logic can tell that from a genuine
replacement without more information than the API gives us.

---

## #17 — A real-account scan that silently inventoried the mock

**The worst bug in this project so far, and it took a real AWS account to find.**

**Symptom.** With `AWS_MODE=real` and a genuine role ARN configured, the
connection test reported success, and a scan completed in 1.8 seconds reporting
98 resources — labelled with the real account id. Everything looked right.

The resources were `northwind-public-assets`, `northwind-prod-db` and the rest
of the seeded fixture. The scan had enumerated **the mock**, stamped it with a
real AWS account id, and reported success.

**Diagnosis.** `AWS_ENDPOINT_URL` is a documented AWS SDK environment variable
that overrides the endpoint for _every_ client. `.env` carries it, pointing at
moto — and dotenv loads `.env` into `process.env`, which the SDK reads directly.
So even though the code carefully omits the endpoint override when
`AWS_MODE=real`, the SDK applied one anyway, to every service including STS.

moto accepts any `sts:AssumeRole` it is given and echoes back a plausible
assumed-role ARN, so the connection test passed. The account id in the response
came from the configured role ARN, which was genuinely the customer's. Every
signal available to the user said "connected".

A second, related bug sat behind it: `.env` also carries
`AWS_ACCESS_KEY_ID=mock`, and the SDK's environment credential provider is the
_first_ in its chain. So the placeholder did not merely fail to be used in real
mode — it actively shadowed `~/.aws/credentials`.

**Fix.** In `real` mode, `config.ts` now deletes `AWS_ENDPOINT_URL` (and its
per-service variants, and the dualstack/FIPS flags) and any non-genuine
`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` from `process.env`, warning loudly
about each. Deleting them is the only fix that works, because the SDK reads
`process.env` itself rather than anything we control. Values that look like real
AWS keys are left alone. The connection test now also reports which endpoint it
used, so this can never again be invisible.

**What to take from it.** Two things, and the second is the uncomfortable one.

Configuration that a library reads from the ambient environment is not
configuration you own. Passing the right options to a client is not enough when
the client also reads `process.env` — and `dotenv` turns a project's config file
into ambient environment, which is exactly what makes this easy to miss.

And: this project's central argument is that a confident, plausible, wrong
answer is the failure mode worth engineering against — deterministic analysers,
validated citations, an eval suite. It then produced a confident, plausible,
entirely fabricated inventory of somebody's AWS account, and every check it owns
passed, because all of them validate the data _after_ ingest and none asked
whether ingest was talking to the right cloud. The defences were pointed
downstream of where this went wrong.

---

## #18 — Prettier silently deleted 47 lines of a CloudFormation template

**Symptom.** An edit to `infra/readonly-role.yaml` failed to apply because the
text it matched was gone. The file was 208 lines; the committed version was 255.

**Diagnosis.** `npm run lint` runs `prettier --check .`, and `prettier --write .`
had been reformatting the template. Prettier's YAML formatter rewrites folded
block scalars (`Description: >`), and in doing so dropped most of the
explanatory header — the whole rationale for replacing `ReadOnlyAccess`,
including the analysis the README points at.

No test covers a template's comments, and CI checks formatting rather than
content, so nothing failed. It surfaced only because a later edit could not find
its anchor.

**Fix.** Restored from git, and `infra/*.yaml` added to `.prettierignore` with
the reason. CloudFormation also uses short-form intrinsics (`!Ref`, `!Sub`,
`!GetAtt`) that are not portable YAML tags, so it is not a file a general YAML
formatter should be touching at all.

**Worth recording** because the damage was invisible and the tool was one added
to improve quality. A formatter that rewrites a file type it does not fully
model will eventually corrupt it, and the files most at risk are the ones with
no tests — documentation and infrastructure templates.

---

## #19 — The onboarding guide taught the mistake it was meant to prevent

**Symptom.** Following the guide against a real account produced
`AccessDenied`, then `NoSuchEntity`: the configured role did not exist, and
listing the account's roles found nothing matching `/dave/i` at all.

**Diagnosis.** The template has two roles in it and the guide did not
distinguish them clearly enough. `DaveIoScannerRoleArn` is an **input** — the
principal permitted to assume — while the role the stack **creates** is
`DaveIoReadOnlyRole`, and it is the created one that belongs in
`AWS_TARGET_ROLE_ARN`. The guide said "the scanner role ARN from your onboarding
email", which presumes a dave.io account that does not exist for someone running
the project themselves. Reasonably, the value from step 3 was carried into
step 4.

Two smaller failures compounded it. The template's `AllowedPattern` accepted
only a role ARN, and a self-hosted deployment's identity is commonly an IAM
user. And configuration is read once at startup, so editing `.env` without
restarting the API changed nothing — which the guide never said.

**Fix.** The connection endpoint now returns the identity the backend actually
runs as, and the guide pre-fills it into the deploy command, so there is nothing
to work out. Step 3 states the input/output distinction and the error each
mix-up produces. Step 4 says to restart, and to remove the mock's environment
variables. The template accepts a user ARN and documents the single-account case.

**Worth recording** because the guide was written to prevent exactly this
confusion and instead transmitted it. Documentation written by someone holding
the whole model in their head will omit the distinction that is obvious to them,
and the only reliable way to find out is to watch someone follow it.

---

## #20 — The IAM template had never been deployed, and did not work

**Symptom.** Deploying `infra/readonly-role.yaml` to a real account failed and
rolled back:

```
Policy arn:aws:iam::aws:policy/ViewOnlyAccess does not exist or is not
attachable. (Status Code: 404)
```

**Diagnosis.** `ViewOnlyAccess` is an AWS **job function** policy, so it lives
at `arn:aws:iam::aws:policy/job-function/ViewOnlyAccess`. The obvious ARN — the
one every other managed policy uses, and the one I wrote — does not exist.
`SecurityAudit`, attached on the line above, _is_ at the root, which makes the
inconsistency easy to miss.

Confirmed rather than guessed:

```
aws iam list-policies --scope AWS --query "Policies[?PolicyName=='ViewOnlyAccess'].Arn"
-> arn:aws:iam::aws:policy/job-function/ViewOnlyAccess
```

**Why nothing caught it.** The template is documentation as far as this
repository is concerned: nothing deploys it, no test exercises it, and the mock
never sees it — moto is handed credentials, not a CloudFormation stack. The
README describes its permissions in detail and ADR-007 argues carefully for
them, and the artefact that would grant them had never been run once.

A second trap followed: a stack that fails on creation sits in
`ROLLBACK_COMPLETE`, which cannot be updated. It has to be deleted before
redeploying, and `aws cloudformation deploy` does not say so.

**Fix.** Corrected the ARN, deleted the failed stack, redeployed. Then verified
the permission model against real IAM rather than trusting it:

```
aws iam simulate-principal-policy --policy-source-arn <role> --action-names ...

  s3:GetObject                   explicitDeny
  secretsmanager:GetSecretValue  explicitDeny
  sqs:ReceiveMessage             explicitDeny
  s3:ListBucket                  allowed
  ec2:DescribeInstances          allowed
  iam:ListRoles                  allowed
  s3:DeleteBucket                implicitDeny
```

Every claim ADR-007 makes, confirmed by AWS's own policy simulator — including
the `sqs:ReceiveMessage` deny that the whole argument for replacing
`ReadOnlyAccess` turns on. `simulate-principal-policy` is in the template's
outputs so a customer can run it themselves rather than taking our word for it.

**What to take from it.** Infrastructure code that is never executed is a
hypothesis. This one was argued for over several hundred words of documentation
and had a 404 in it. The same is true of any artefact CI does not run: the
scanner is tested every commit and the template it depends on was not, because
one is code and the other looked like documentation.

---

## #21 — A configuration knob that existed only in code

**Symptom.** `AWS_SCAN_REGIONS` was set empty in `.env` to trigger region
discovery, and the scan still covered exactly three regions.

**Diagnosis.** The key was not in `.env` at all — my edit had matched nothing —
because it had never been in `.env.example` either. It existed only as a Zod
default in `config.ts`, set to the three regions the mock uses. So the intended
production behaviour (discover every enabled region) was unreachable by anyone
who had not read the source.

**Fix.** Documented in `.env.example`, along with `SCAN_CONCURRENCY` and
`SCAN_FAULT_INJECTION`, which had the same problem. With discovery enabled the
scan covered **17 regions, 70 units, 288 API calls, no failures** on a real
account.

**Worth recording** because the default was chosen to make the mock convenient
and quietly became the product's behaviour. A default that suits your test
fixture is worth a second look, and a setting absent from the example
configuration effectively does not exist.

---

## #22 — The template lost its reasoning twice, so now a test holds it

**Symptom.** After correcting the `ViewOnlyAccess` ARN and committing, the
template was 215 lines. The previous commit had 282. Seventy-four lines had gone
again — the same explanatory header Prettier had already removed once (#18),
including the entire `ReadOnlyAccess` rationale the README points readers at.

**Diagnosis, partial and honestly so.** The first occurrence was definitely
Prettier reformatting a folded block scalar. The second was not: Prettier
reported the file as ignored (`--file-info` → `"ignored": true`), and the AWS
CLI was ruled out empirically by hashing a copy either side of a
`validate-template` call. The cause of the second truncation was never
identified.

**Fix.** Restored from the last good commit, re-applied the ARN correction, and
stopped investigating in favour of making it impossible to miss:
`infra/template.test.ts` asserts both halves of what the template is for.

_The permissions_: ViewOnlyAccess at its job-function path and never the root
one, SecurityAudit present, `ReadOnlyAccess` absent (and present in the original,
kept for comparison), every data-plane action the README names appearing under
an explicit Deny, trust scoped to a named principal rather than `:root`, and the
external id and SourceIdentity conditions intact.

_The reasoning_: the rationale header, the `sqs:ReceiveMessage` visibility-timeout
argument, the `:root` explanation, the two-role warning, and a line-count floor.

Verified by simulating the exact corruption — stripping the `Description` block
— and confirming four tests fail, then restoring.

**What to take from it.** Content guards on prose look strange, and they earn
their place here because this content has been silently deleted twice by tools
that were added to improve quality. More generally: the parts of a repository
with no tests are the parts that rot, and "it's only documentation" is precisely
why nothing noticed. The template was simultaneously the most carefully argued
artefact in the project and the only one that had never been run or checked.

---

## #23 — The test suite scanned a real AWS account

**Symptom.** With `.env` switched to a real account, `npx vitest run` failed ten
ground-truth assertions. They were checking for `northwind-public-assets` and
finding a real estate instead.

**Diagnosis.** The ground-truth suite seeds the mock fixture and then calls
`runScan()`. `runScan` reads the same configuration the application does, so in
`real` mode it scanned the real account — the seeding was irrelevant, and the
assertions were comparing a fixture answer key against somebody's actual
infrastructure.

The failing tests were the least of it. **Running the test suite made live AWS
API calls against a real account.** Read-only ones, and it still should not
happen: a test run must not depend on, or touch, a real cloud account. On a
customer's estate it would put a few hundred unexplained calls in their
CloudTrail, attributed to a scan nobody asked for.

`npm run verify` had passed throughout, because it excludes the eval directory —
so the guard I had built for exactly this class of mistake did not cover it.

**Fix.** The suite now checks `isMock` before anything else and skips with an
explicit reason. Verified both directions: it skips with `.env` in real mode,
and still runs properly when pointed at the mock.

**What to take from it.** A test that reads application configuration inherits
whatever the developer happens to have configured, and "whatever they happen to
have configured" eventually includes production credentials. Anything that can
reach a real environment should assert it is not in one, first and loudly,
rather than relying on the environment being right — the same argument as ADR-009
and engineering log #17, arrived at from a third direction.

---

## #24 — The toggle quietly disabled the project's own onboarding variables

**Symptom.** Found by auditing the repository against the brief rather than by
any failure. `AWS_TARGET_ROLE_ARN` and `AWS_EXTERNAL_ID` — the two AWS
onboarding variables the assignment itself ships, and the ones `.env.example`
documents — had stopped having any effect in mock mode. Editing either appeared
to do nothing.

**Diagnosis.** Adding the runtime account toggle (ADR-013) meant the mock
profile had to come from somewhere other than `.env`, because `.env` might be
describing a real account that the user had toggled away from. I made the mock
profile derive its role ARN and external id unconditionally, which solved that
case and silently broke the ordinary one: a fresh clone, where `.env` _is_ the
mock configuration.

**Fix.** The mock profile now honours `.env` whenever the **configured** mode is
mock, and derives values only when `.env` describes a real account and the user
has toggled away from it. Verified by changing the external id and watching the
connection endpoint report the new value.

One consequence, stated rather than hidden: `.env` describes exactly one
account. From a mock configuration the "My AWS" toggle is disabled, with a
tooltip saying no real account is configured, because there is nowhere for real
credentials to live. That is honest, and the alternative — a second set of
`REAL_*` variables — buys little for a single-tenant tool.

**What to take from it.** A feature added for the unusual case quietly changed
the usual one. The toggle exists for a demo convenience; the variables it
overrode are the project's primary interface. Worth asking, when a new mode
needs configuration from somewhere other than the obvious place, whether the
obvious place has just stopped working.

---

## #25 — The eval CLI would have run sixteen fixture questions at a real account

**Symptom.** Noticed while fixing #24, before it bit anyone.

**Diagnosis.** `npm run evals` reads the same configuration as the application.
With `.env` pointed at a real account it would have asked sixteen questions
about `northwind-prod-db`, `prod-bastion` and friends, failed all of them for
the same uninteresting reason, and spent money on model calls to get there.

Exactly the hazard the ground-truth suite had (#23), in the sibling command,
and the fix for that one had not been generalised.

**Fix.** The same guard: refuse unless `isMock()`, with a message pointing at
both ways to get there — `AWS_MODE=mock`, or the UI's Demo toggle followed by a
rescan.

**Worth recording** because fixing a bug in one place and not looking for its
siblings is how the second instance gets found in production. Both commands read
application configuration and assert against a fixture; that shape is the thing
to search for, not the specific file.

---

## #26 — A live API key reached git history, and the secret scan passed

**The most serious mistake in this project, and mine.**

**Symptom.** Found by auditing `.gitignore` coverage during a review, not by any
tool. A file called `.env.mock-backup` — which I created while switching the
project between the mock and a real AWS account — had been **committed**, across
three commits. It contained a live `ANTHROPIC_API_KEY` and a per-customer
`AWS_EXTERNAL_ID`, which the role template itself describes as a credential.

**Diagnosis.** Two independent failures, and it needed both.

`.gitignore` listed exact filenames — `.env`, `.env.local`, `.env.*.local`.
`.env.mock-backup` matches none of them. The pattern covered the files someone
had thought of, which is the wrong basis for a rule whose whole job is catching
what you did not think of.

And CI's gitleaks step passed on every one of those commits. Its default rules
did not match the Anthropic key format, and nothing checked the simpler,
stronger invariant: that no environment file should be tracked at all.

**Fix (partial — the rest is not mine to do).**

`.gitignore` now ignores anything env-shaped (`.env`, `.env.*`, `*.env`) and
re-includes `.env.example` explicitly. A `.gitleaks.toml` adds rules for
`sk-ant-` keys and for a non-placeholder `AWS_EXTERNAL_ID`. And CI gained a
deterministic backstop that does not depend on pattern matching at all: if
`git ls-files` returns any env file other than the example, the build fails.
Verified locally against the current tree.

**What it does not fix.** The secrets remain in history. Rewriting it requires a
force-push, which is the repository owner's decision, and the key needs rotating
regardless — a leaked credential is leaked the moment it is pushed, whatever
happens to the commit afterwards.

**What to take from it.** Three things, and the second is the one worth
remembering.

A denylist of filenames fails exactly when it matters. `.gitignore` for secrets
should describe the _shape_ of the thing, and re-admit the exceptions.

A green security check is not evidence of absence — it is evidence that the
rules you configured did not match. gitleaks was in CI from the first day
precisely because this repository holds credentials, and it passed while a live
key sat in the tree. The backstop that would have caught it is trivial and does
not involve detecting secrets at all: _no environment files may be tracked._
When a probabilistic check guards something important, pair it with a
deterministic one covering the common case.

And the file was created by a convenience step, during work on something else,
named in a hurry. It was not part of any feature. The riskiest artefacts are
usually the incidental ones, because nobody reviews them.

---

## #27 — The secret scan I added to catch #26 was not running

**Symptom.** CI went red immediately after the history rewrite. The `Secret
scan` job failed with `Error: File results.sarif does not exist`, which is the
action failing to upload a report rather than a useful message.

**Diagnosis.** Further up the log:

```
panic: regexp: Compile(`(?i)aws_external_id\s*=\s*(?!replace-me|local-dev|<)...`):
error parsing regexp: bad perl operator: `(?!`
```

The rule I had just written to catch leaked external ids used a negative
lookahead to exclude placeholders. gitleaks is written in Go, and Go's RE2 has
no lookarounds by design — it guarantees linear-time matching, which lookarounds
break. So gitleaks panicked at startup and scanned nothing.

**Fix.** Exclusions moved into a rule allowlist, which is the mechanism gitleaks
provides for exactly this. Verified there are no lookarounds left in any rule
regex, that the TOML parses, and that CI's secret scan now passes rather than
crashing.

**What to take from it.** The failure was loud here only by luck: the action
happened to exit non-zero because a later step could not find its output file.
A panic that had been swallowed would have left a green "Secret scan ✓" next to
a scanner that ran no rules — which is strictly worse than having no scanner,
because it is trusted.

That is the same shape as #26, one level up. There, a green gitleaks meant "my
rules did not match"; here it would have meant "my rules did not load". Both
argue for the same thing: pair a probabilistic check with a deterministic one.
The `git ls-files` guard added in #26 needs no rules, no regex engine, and
cannot silently do nothing — and it would have caught the original leak on its
own.

---

## #28 — Four bugs in the onboarding path, found by someone actually using it

Tom deployed the role template into his own AWS account and worked through the
UI's connection guide. Nothing in the repository was broken in a way any test
could see, and four separate things went wrong. They are worth recording
together, because they share a cause: every one of them is a place where the
code was correct and the _path through it_ was not, and none of them is
reachable from the unit tests.

### 1. The template could not be deployed at all

```
An error occurred (ValidationError) when calling the CreateChangeSet operation:
Template format error: 'Description' length is greater than 1024
```

CloudFormation caps a template's `Description` at 1024 characters. The
explanatory header — the rationale for replacing `ReadOnlyAccess`, the
`:root` argument, the two-role warning — had grown to **3,952**, nearly four
times the limit. The whole point of #18 and #22 was that this prose kept getting
deleted and needed protecting; the guards I wrote to protect it checked that the
words were present and never checked whether the file still deployed.

So the tests passed, the reasoning survived, and the artefact was unusable.
Tom's workaround was the obvious one: delete the prose to get the deploy
through, which is exactly the outcome the guards existed to prevent.

**Fix.** The prose moved into `#` comments. Comments have no length limit and
are stripped before the template is evaluated, so the explanation now costs
nothing at deploy time — it should never have been in `Description`, which is a
UI string shown in the CloudFormation console, not a place for an essay. Two new
guards assert the folded `Description` stays under 1024 and the role's own stays
under IAM's 1000. Run against the previous commit, the first one fails with
`Description is 3952 chars`.

**What to take from it.** A guard on content is not a guard on validity. I had
written tests that asserted the file still _said_ the right things, and none
that asserted it still _worked_ — and the two failed in opposite directions, so
the passing tests actively obscured the broken artefact.

### 2. The connection guide told people to paste an ARN that cannot work

Step 3 pre-fills the CloudFormation command with the identity this backend runs
as, so nobody has to work out which principal to trust. It filled it from
`sts:GetCallerIdentity` verbatim, which is wrong in a way that is one character
wide.

`GetCallerIdentity` reports the **session** you are using, so it returns an
`arn:aws:sts::…` ARN. An IAM trust policy needs the **identity** behind that
session, which is always `arn:aws:iam::…`. Against the mock the guide emitted

```
DaveIoScannerRoleArn=arn:aws:sts::123456789012:user/moto
```

— moto's own identity, offered as the principal to trust in somebody's real AWS
account. The template's `AllowedPattern` rejects it, which is the only reason
this failed loudly. Against a real assumed-role session it would emit
`arn:aws:sts::…:assumed-role/Role/session`, which also fails the pattern; and a
hand-written trust policy that accepted the `sts` form would deploy cleanly and
then never match, giving `AccessDenied` on every scan with nothing to point at.

**Fix.** `aws/principal.ts` converts a caller identity into a principal ARN —
`assumed-role/Role/session` → `role/Role`, `sts::…:user/x` → `iam::…:user/x` —
and returns a _reason_ rather than a guess for the cases that have no answer
(federated sessions, the account root). The guide shows the converted value,
says it converted it, and warns when the identity came from the mock rather than
from AWS. Fourteen tests, including one asserting that every ARN it returns
satisfies the template's own `AllowedPattern`.

### 3. `AWS_TARGET_ROLE_ARN` held a user ARN, which can never be assumed

`.env` had been set to `arn:aws:iam::<account>:user/dave-home-assignment`. That
is a correct and useful ARN — it is the answer to the question asked two steps
earlier, the principal the trust policy should name. It is not something
`sts:AssumeRole` can assume; only a role is.

The two variables sit next to each other in the guide, and each one's correct
value looks exactly like a plausible value for the other. The template's header
already warned about this mix-up in prose. Prose is not a control.

**Fix.** `validateAssumeRoleTarget()` rejects a non-role ARN, names the mix-up
specifically, and says where the right value comes from (the stack's `RoleArn`
output). It warns at startup and surfaces through `/api/connection`, so the UI
shows it — deliberately **not** a fatal error, because the screen that explains
the fix is in the app, and a process that exits on bad configuration cannot tell
you how to correct it.

### 4. `AWS_REGION=` was set, and therefore was not set

`.env` contained `AWS_REGION=` with nothing after it. Zod's `.default()` only
fires on `undefined`, and an empty line in a `.env` file parses as `""` — a
perfectly valid string. So `cfg.AWS_REGION` was `""`, every AWS client was
constructed with an empty region, and the failure surfaced from whichever client
was built first, as `Region is missing`.

**Fix.** A `blankAsUnset` wrapper treats `""` as absent. Applied to every
variable where blank means nothing — and deliberately **not** to
`AWS_SCAN_REGIONS` or `SCAN_FAULT_INJECTION`, where blank is a documented,
meaningful value ("discover every region", "inject no faults"). Collapsing those
into their defaults would have silently changed behaviour the README promises,
which would have been a worse bug than the one being fixed.

### And a fifth, which only a real account could reveal

With all four fixed, the connection test still failed. The stack's trust policy
named `user/dave-home-assignment`; the host's ambient credentials were
`user/terraform-bootstrap`. Both are real identities in the same account, and
the mismatch is invisible from either side alone.

The diagnosis said "the trust policy does not name this principal" — true, and
it leaves the reader to work out which principal that is. The service knows
exactly who it is authenticating as, so it now says so, and gives the command
that shows what the policy actually names:

```
This backend is authenticating as arn:aws:iam::…:user/terraform-bootstrap.
The stack's trust policy has to name exactly that principal, so if it was
deployed with a different one, redeploy with DaveIoScannerRoleArn=…, or give
this host credentials for the principal it does name.
Check with: aws iam get-role --role-name DaveIoReadOnlyRole …
```

**What to take from the set.** The tests covered the components; all four bugs
lived in the seams between them, and the fifth lived outside the repository
entirely. Three of the four were in code whose job is to _explain_ something —
the template's header, the guide's deploy command, the connection test's error
message — and the failure mode of explanatory code is that it stays confidently
wrong, because nothing downstream consumes it. A wrong ARN in a code path
throws; a wrong ARN in an instruction gets pasted.

The cheapest fix for all of it was the same: make the thing that explains also
be the thing that computes. The guide no longer prints an identity and hopes it
is pasteable — it prints the output of a tested function whose contract is "this
satisfies the template's own pattern".

---

## #29 — "No admin roles" was true, and read as "nobody has admin"

**Symptom.** With the real-account connection finally working (#28), a scan of
Tom's account returned a completely empty findings panel. No public buckets, no
exposed resources, no idle spend, and **no administrators**.

The first four were correct — it is a small, tidy account. The last was not.
Two of its three IAM users hold `arn:aws:iam::aws:policy/AdministratorAccess`.

**Diagnosis.** Two independent gaps, both of which had to be closed.

The IAM collector inventoried users with their name, path, creation date and
last password use, and nothing about their permissions. It fetched attached and
inline policy documents for _roles_ only.

The pipeline's admin loop then read:

```ts
// --- Which principals are administrators? ---
for (const resource of resources) {
  if (resource.kind !== "IamRole") continue;
```

The comment asks about principals. The code filters to roles. That gap had
survived every review, including two full audits against the brief, because
the mock account contains no IAM users at all — so no test could have caught
it, and the reason no test caught it is that the fixture shared the blind spot.

The analyser itself was never the problem: it evaluates policy documents, which
are identically shaped for both. Only collection and that one filter were
role-specific.

**Why it is worse than a missing feature.** The tool did not say "I do not
check users". It said, through an empty panel and the words "No role grants
unrestricted access", something a reader will take as "this account has no
administrators". A gap that presents as a clean bill of health is the one kind
of false negative a security tool cannot ship — and it is the exact failure
this project argues against elsewhere, in ADR-004 (analysis belongs in
deterministic code) and in the public-vs-unprotected split of ADR-012.

**Fix.**

- The collector fetches `ListAttachedUserPolicies`, `ListUserPolicies` and
  `GetUserPolicy`, reusing the managed-policy document cache so
  `AdministratorAccess` attached to six principals is still fetched once.
- The pipeline filter accepts `IamRole` and `IamUser`.
- `findAdminPrincipals` matches both labels and returns the real `kind`.
- The mock account gains three users: one admin by managed policy, one admin by
  an inline policy called `BackupHelper` (so the check cannot pass by pattern
  matching policy names), and one scoped user as the negative class.
- Three ground-truth checks cover them. Reverting only the pipeline filter fails
  two of the three, so they are discriminating rather than decorative.
- The API field `adminRoles` became `adminPrincipals`, and the UI's empty state
  and stat label changed with it. A field named after roles that returns users
  is the same bug in a different place.

**A detail the fix turned up.** The panel annotates an admin role used by
nothing as "candidate for removal". That inference does not transfer: a user has
no instance profile or Lambda to be _used by_, so an empty `usedBy` says nothing
about whether it is in use. An admin user is annotated as standing admin via
long-lived credentials instead — which is the actual risk, and the opposite of
"probably safe to delete". The agent's tool description says the same thing, so
the model does not make the inference either.

**Verified against the real account.** Both users are now reported by name, with
the specific grant:

```
IamUser terraform-bootstrap — Grants Action "*" on Resource "*"
                              via the managed policy "AdministratorAccess"
```

**What to take from it.** A fixture that shares the production blind spot proves
nothing, however green it is. The mock account was built to be adversarial about
everything I thought of — a bucket that looks public and is not, admin granted
inline under a boring name, a database flagged public that nothing can reach —
and it contained no IAM users, so the one analysis that only ever read roles
passed everything. A hundred and fifty-seven tests said this worked.

The bug was found by pointing the tool at a real account and disbelieving a
clean result. That is worth more than another test written against the same
mental model that produced the code, and it argues for keeping a real-account
smoke test in the loop rather than trusting the fixture to be complete.

---

## #30 — An idle-detection rule that was correct and never fired once

**Symptom.** Found by auditing the README against the running system rather than
by any failure. The README lists "an unassociated elastic IP" among the mock
account's waste. The idle findings never contained one.

**Diagnosis.** Every part of the feature existed. The seed allocated an
unassociated address. The collector fetched it. The analyser had a rule for it.
The rule asked:

```ts
const associated =
  resource.properties["associationId"] !== null ||
  resource.properties["instanceId"] !== null ||
  resource.properties["networkInterfaceId"] !== null;
```

moto reports an unassociated address as `InstanceId: ""` and
`NetworkInterfaceId: ""` — empty strings, not absent keys. The collector wrote
them through with `?? null`, which only substitutes for `undefined`. So
`"" !== null` was true, every orphaned Elastic IP read as associated, and the
rule returned "in use" for the only case it existed to catch.

This is the same defect as the blank `AWS_REGION=` in #28, in a different file:
**an empty string is a present value to any check written against null**, and
the failure is silent both times.

**Why nothing caught it.** The ground-truth answer key did not list the address
either. `idleResources` named five resources, the scanner found those five, the
check passed. The fixture and the code shared the omission — the same failure
shape as #29, two entries apart, which is what makes it worth recording rather
than quietly fixing.

**Fix.**

- `absentIfBlank()` at the collector boundary, normalising `""` and whitespace
  to `null` for every Elastic IP field, including the one that builds the
  `ATTACHED_TO` relationship.
- The analyser tests _presence_ rather than `!== null`, as a second layer. Not
  redundant: the analyser should not become silently wrong if a future collector
  or a different AWS response shape reintroduces a blank.
- The orphaned address is tagged `orphaned-eip` in the seed so the answer key
  can name it — an untagged address is identified only by a per-seed random
  allocation id, which is useless in a fixture.
- Added to `idleResources`, plus six unit tests stating the empty-string case
  explicitly, including that a NAT gateway's address (no `InstanceId`, but a
  real `NetworkInterfaceId`) is still correctly _not_ idle.

Idle spend in the mock account went from $98.85 to $102.50/month, and the README
figure was wrong by exactly one Elastic IP.

**What to take from it.** Two bugs of the same shape in two days argues the
shape is worth a rule rather than a fix each time: **normalise "absent" at the
boundary where data enters, once, and never ask `!== null` about a string that
came from an external API.** The AWS SDK is inconsistent about it between
services and between real AWS and moto, so every collector is exposed.

---

## #31 — A mock scan recorded under a real AWS account id

**Symptom.** While investigating an unrelated eval failure, the scan table read:

```
started_at                    | account_id   | resources
2026-09-25 21:24:36+00        | 672299759593 | 100
2026-09-25 21:00:16+00        | 123456789012 | 100
```

100 resources is the mock account's inventory. `672299759593` is a real AWS
account. The top row is the mock's data, persisted under the real account's
identity.

**Diagnosis.** The command was `AWS_MODE=mock npm run scan`, against a `.env`
configured for the real account.

`AWS_MODE=mock` on the command line makes `configuredMode` "mock". The mock
branch of `activeConnection()` then honoured `cfg.AWS_TARGET_ROLE_ARN` —
deliberately, because #24 established that silently ignoring the project's own
onboarding variables was a nasty surprise. But `AWS_TARGET_ROLE_ARN` still named
the _real_ account, while the endpoint override sent every call to moto. The
account id is derived from the role ARN, so the scan read the mock and labelled
it with a real twelve-digit account.

**This is #17 arriving through a different door.** There, a leaked
`AWS_ENDPOINT_URL` made real mode scan the mock. Here, a mode override makes
mock mode wear a real account's name. Both produce the same artefact: a
confident, complete, entirely fictional inventory of somebody's real AWS
account, sitting in the database looking exactly like a genuine scan. It is the
worst output this system can produce, and it is now the second time I have
built a route to it.

It also had a visible second-order effect: the `changed-since-last-scan` eval
failed with "I wasn't able to reach a conclusion within the tool-call limit",
because the diff compared two scans of nominally different accounts. A 100%
spurious diff looks like a broken agent.

**Fix.** The test for "does `.env` describe the mock?" is the **account id**,
not the mode flag:

```ts
honoursConfiguredArnInMock(mode, targetRoleArn, mockAccountId)
  => mode === "mock" && accountOfArn(targetRoleArn) === mockAccountId
```

A configured ARN naming any other account is configuration for a different
account, and is ignored in favour of the mock's own identity, with a warning
naming both account ids. #24's intent survives — the onboarding variables are
still authoritative when they genuinely describe the mock.

Extracted as a pure exported function with ten tests, because the module around
it reads `process.env` at import time and the condition was therefore
untestable in place. That is the real lesson of the fix: the decision was
load-bearing and unreachable by any test, which is why it was wrong twice.

**What to take from it.** Both routes to this failure share a cause: **two
sources of truth for "which account am I looking at?"** — the endpoint the calls
go to, and the ARN the results are labelled with — and nothing that asserts they
agree. A single invariant, checked once where the connection is resolved, closes
both doors and any third I have not found. The general form: when two
configuration values must be consistent, do not document the requirement,
compute one from the other or refuse.

---

## #32 — The citation validator caught the agent inventing an ARN, and the tool was at fault

**Symptom.** A tier-2 eval run failed on `blast-radius` with an unsupported
citation — the fatal category, since an invented identifier is the one failure a
user cannot catch:

```
cited unsupported ARNs: arn:aws:ec2:us-east-1:123456789012:instance/
```

The answer opened:

> From `prod-web-1` (arn:aws:ec2:us-east-1:123456789012:instance/… — let me
> confirm exact ARN) a compromise could reach 3 resources…

**Diagnosis.** The validator was right and the model was not really wrong.
`find_reachable_from` returned only the _targets_ of the reachability search,
never the source. The question is "if prod-web-1 were compromised, what could it
reach?", so every possible answer names prod-web-1 — and its ARN was not in any
tool result, so it was not citable. The model hedged with a truncated ARN prefix
and said so in the text.

**The uncomfortable part is that I already knew.** Engineering log #13 records
this exact case failing, and the conclusion I drew then was that the _test_ was
wrong: I removed `prod-web-1` from the case's expected resources, with a comment
explaining that the source is not citable because the tool does not return it.
That made the suite green and left a tool whose result set cannot support the
obvious answer to its own question. The defect waited two days and came back as
a fabricated identifier.

**Fix.** The tool returns the source at `hops: 0`, so it is citable. The eval
case expects `prod-web-1` again — a fix, not a revert, since the reason it was
removed no longer holds. The tool description says the source is included.

The lookup is a separate query, which also buys a distinction the single query
could not express: **no rows means no such resource; one row means the resource
exists and reaches nothing.** Those were previously the same empty result, so
"this host is isolated" and "I could not find this host" were indistinguishable
to the agent — a second, quieter defect in the same function.

**What to take from it.** When an eval fails, "the test is wrong" and "the
system is wrong" are both live hypotheses, and #13 shows I am capable of
choosing the first too quickly. The tell I missed: I relaxed an assertion and
wrote a comment justifying it in terms of a _system limitation_. That comment
was a defect report in the wrong file. A test relaxed because the system cannot
satisfy it should open an issue, not close one.

The validator, meanwhile, did exactly its job — it turned a plausible-looking
hedge into a hard failure two days before anyone demoed it. That is the argument
for ADR-006 in one line.

---

## #33 — Two test expectations that were wrong about the shell

**Context.** Building remediation (ADR-014), which emits shell commands for a
human to run. Two of the first tests failed, and both times the implementation
was right.

**The quoting one.** `shellQuote("it's")` produced `'it'\''s'` and the test
expected `'it\'s'`. The intuitive form is the wrong one: a POSIX single-quoted
string has no escape character at all, so a quote cannot be backslash-escaped
inside it. The correct idiom closes the quoting, emits an escaped quote outside
it, and reopens — which is what the implementation did.

Rather than argue from memory I ran it:

```bash
printf '%s\n' 'it'\''s'      # -> it's
```

The form the test expected is one the shell cannot parse at all. Had I "fixed"
the implementation to match the test, every remediation for a resource with an
apostrophe in its name would have produced a command that fails on paste — and
the tests would have been green.

**The other one** was more ordinary: an assertion on
`release-address --allocation-id …` that omitted the `--region` flag sitting
between them. Also a wrong expectation, also mine.

**What to take from it.** Two for two, on a day when #32 had just finished
recording that I trust "the test is wrong" too readily. The difference here is
that the hypothesis was _checked_ rather than assumed — a five-second shell
command settled the quoting question definitively, and the answer happened to
favour the implementation.

The general form: when a test and the code disagree about how an **external
system** behaves — a shell, an AWS API, a database — neither the test nor the
code is evidence. Go and ask the external system. Both #13 and #32 went wrong
by reasoning about the disagreement instead of resolving it.

**The stakes are also why these are unit-tested at all.** The output of this
feature is text that a person pastes into a terminal holding production
credentials. A quoting bug there is not a rendering glitch; it is a command that
runs and does something other than what it reads as. That is worth a test that
states the exact expected bytes, and worth verifying the expectation against a
real shell before trusting it.

---

## #34 — Three UI bugs that only existed on screen

**Context.** For most of this project I could not see the UI. There was no
browser on the build host, so "the frontend works" meant it compiled, served,
and its endpoints returned correct JSON — which is not the same claim. Building
the handover PDF required headless Chrome, and having installed it for that, it
could be pointed at the running app.

Three bugs, none of which any test could have caught, all found in the first two
screenshots.

**1. The findings tab bar overflowed its sidebar and hid behind a button.**
Six tabs — Overview, Exposed, Admin, Idle, Unguarded, Changes — in a 288px
column. They were laid out `flex` with `flex-1`, which looks like it should
shrink them to fit. It does not: flex items default to `min-width: auto`, so
they refuse to shrink below their content width and overflow instead. They
spilled across the graph pane, where the floating **Filter** button — absolutely
positioned at `z-10` — sat on top of two of them.

So the Unguarded and Changes tabs were partly unreachable, in the panel that
exists to surface findings. Measured rather than guessed: the Changes tab's
bounding box started at x=345 in a column that ends at x=288. Now the row wraps
to two rows of three, and the sidebar has `overflow-hidden` so nothing else can
spill either.

**2. The copy button covered the command it copies.** `Copyable` positioned the
button absolutely inside the `<pre>` and reserved room with `pr-16`. That works
while the block is wide, which is how it was built and where it was seen — the
connection guide's modal. Remediation puts the same component in a 320px side
panel, where the `<pre>` scrolls horizontally, the padding scrolls away with the
content, and the button ends up sitting on the command with a stray character
visible past it.

A copy button obscuring the thing being copied is a bad joke in a feature whose
entire purpose is handing people exact commands. The button now sits in a header
row above the block, which cannot overlap at any width.

**3. A 404 on every page load.** No favicon, so every load logged
`GET /favicon.ico 404` in the console. Trivial, and worth fixing for the same
reason as #12 and ADR-012: a console that cries wolf is one nobody reads when
something real appears. An inline SVG data URI avoids shipping a binary asset
for one 16px glyph.

**What to take from it.** All three are invisible to every kind of test in this
repository, and would have stayed invisible through any number of green runs.
They are also not subtle — one of them hid part of the primary navigation. The
gap was not rigour, it was **never having looked**.

This is the fourth entry in a row (#28, #29, #30, #34) where the finding came
from using the thing rather than testing it, and the pattern is worth stating
plainly: tests check the properties you thought to assert, and a screenshot
checks every property at once, including the ones you would never think to name.
Where the output is visual, look at it. Where it is a command someone will run,
run it (#33). The cheapest verification is usually the one that exercises the
artefact the way its user will.

A smaller lesson inside the first bug: `flex-1` does not mean "shrink to fit".
`min-width: auto` on flex items is one of the few CSS defaults that silently
produces overflow rather than compression, and it is worth reaching for
`min-w-0` by reflex whenever a flex child contains text.

---

## #35 — A documented command that did not exist

**Symptom.** Working through the README command by command, `npm run query -w
@daveio/api` failed: no such script.

**Diagnosis.** `apps/api/src/cli/query.ts` existed, worked, and its own header
comment gave that exact invocation. The npm script was simply never added. So
the CLI had been written, documented in two places, and was unreachable by the
command both of them named.

**The wider problem.** This is the third time documentation in this repository
has been wrong in a way nothing could catch. The CloudFormation template had
never been deployed and did not work (#20). Its explanatory header was silently
deleted twice (#22). And an audit found the README quoting eight ADRs where
there were thirteen, fourteen assertions where there were fifteen, and a test
count stale by thirty-eight.

Each time the fix was manual and each time it rotted again, because the README
is the one artefact everybody reads and nothing executes.

**Fix.** The script, and then a guard of the same shape as the template tests:
`readme.test.ts` extracts every `npm run …` the README tells you to type and
asserts the script exists, then checks the counts it quotes — ADRs, agent tools,
eval cases, tier-1 checks — against the files they describe.

Verified to fire rather than pass vacuously: removing the `query` script and
changing "fourteen ADRs" to "eleven" fails exactly those two cases and nothing
else. That check matters more than usual here, since #23 and #27 are both
entries about guards that silently could not fail.

**What to take from it.** Instructions are an interface, and an interface with
no tests drifts from the thing it describes. The test is eight lines of regex
and it replaces two full manual audits, both of which I had already done and
both of which had missed this one.

It also argues for a specific habit: when a file's own comments document how to
invoke it, that string should be derived from, or checked against, the thing
that actually invokes it. `query.ts` was honest and wrong for as long as it
existed.

---

## #36 — `.env` was never loaded on Windows, and the defaults hid it

**Reported by Tom**, who ran the project on a Windows laptop, put a real key in
`.env`, and got `"agent":"ANTHROPIC_API_KEY not set - chat will fail"` while
looking at the key in the file. Everything else worked: Postgres, Neo4j, the
scan, the graph.

**Cause.** Four files built a filesystem path like this:

```ts
new URL("../../../.env", import.meta.url).pathname;
```

`URL.pathname` is a **URL** path, not a filesystem path. The two coincide only
when nothing in the path needs escaping — which is true on the machine this was
written on, and false in two ordinary situations:

```
Windows           ->  /C:/devops/projects/app/.env     leading slash, drive letter
a space in a dir  ->  /home/me/My%20Projects/.env      percent-encoded
```

`fs` cannot open either. `dotenv` returned ENOENT, and because it was called
with `quiet: true` it failed **silently** — so not one variable from `.env` was
loaded.

**Why only chat broke.** The Zod schema's defaults happen to match
`.env.example`, so Postgres, Neo4j and the mock endpoint all kept working on
defaults that coincidentally matched. `ANTHROPIC_API_KEY` is the one variable
with no default, so it was the only visible symptom — and it pointed at the
wrong thing. Every other value Tom might have edited (ports, passwords,
`AWS_MODE=real`, scan regions) was being ignored just as completely, with no
symptom at all. A Windows user switching to a real AWS account would have
silently scanned the mock.

That is the same shape as engineering log #28's blank `AWS_REGION=`: a
configuration failure masked by a default, where the default is the thing that
makes it hard to find.

**It is not a Windows bug.** Verified here on Linux, which is the part the
original report did not cover:

```
pathname      : …/My%20Projects/.env   exists: false   dotenv: FAILED ENOENT
fileURLToPath : …/My Projects/.env     exists: true    dotenv: ok, key loaded
```

Any checkout under a directory containing a space, a `#`, or a non-ASCII
character fails identically on macOS and Linux. The Windows case is simply the
one that shows up first, because every Windows path starts with a drive letter.

**Fix.** `fileURLToPath` from `node:url`, which is the documented conversion and
correct on every platform, in all four places: the API config (which serves the
server and every API CLI), the seed CLI, the drift CLI, and the `evals/results/`
directory path.

**Three guards, because the bug had three properties worth preventing.**

1. The computed `.env` path must land in the directory that contains
   `.env.example`, and must not look like a URL path.
2. **No source file anywhere may use `import.meta.url).pathname`.** `URL.pathname`
   has legitimate uses; none of them are in this codebase, and every use of it
   here was a bug. A flat ban is enforceable in eight lines and would have
   prevented all four at once. Verified to fire: reintroducing it in the seed
   CLI fails the test and names the file.
3. The mechanism itself is pinned as an executable assertion, so the reasoning
   above cannot quietly become folklore.

**And the message that made it a mystery.** `/api/health` said "ANTHROPIC_API_KEY
not set", which was true and useless. It now names the file it read, and
distinguishes "you have not set it" from "no `.env` found at this path" — the
second being the one a user cannot guess. The README also now says that
`tsx watch` does not watch `.env`, so editing it while the API is running
changes nothing until a restart.

**What to take from it.** Two things.

The first is narrow and worth memorising: **`URL.pathname` is not a filesystem
path.** It is one of a small set of APIs that look interchangeable with the
right one and differ only in cases you will not hit locally.

The second is the recurring one. This is the fourth entry where a default
concealed a failure (#17, #28, #31, #36), and the pattern is always the same:
the fallback is reasonable, the fallback matches what the file would have said,
and so the system works while being misconfigured. A default that silently
substitutes for configuration the user believes they supplied is a trap — which
is why `quiet: true` on a loader whose failure mode is "load nothing" was the
real mistake, not the path expression.

The bug also survived every check this repository has, including a clean-clone
test run twice. It could not have been otherwise: CI runs Linux, the author's
machine runs Linux, and the path has no spaces. Cross-platform correctness is
not something a single-platform test suite can assert, and the honest response
is a lint-style ban on the idiom rather than a test that pretends to cover it.

---

## #37 — HTTP 414 on every IAM role with a path

**Reported by Tom**, against his own AWS account: clicking some resources — IAM
roles and instance profiles specifically — showed nothing, and the request came
back `414 URI Too Long`.

**Cause.** Fastify caps a route parameter at **100 characters** by default.
`/api/resources/:arn` carries an ARN as that parameter, and AWS creates
service-linked roles with an IAM _path_:

```
arn:aws:iam::672299759593:role/aws-service-role/elasticloadbalancing.amazonaws.com/AWSServiceRoleForElasticLoadBalancing
```

120 characters. Over the cap, so `find-my-way` refused to route it and returned
`FST_ERR_MAX_PARAM_LENGTH` with status 414 before any handler ran. The
remediation route has the same shape, so **"How to fix" was broken for exactly
the admin roles it matters most for.**

In Tom's account, **10 of 19 IAM roles and instance profiles were over the cap**,
the longest at 145 characters. More than half the IAM section of the product was
unreachable.

**Why the fixture never caught it.** Every role in the mock account has a short,
path-less name — the longest fixture ARN is 61 characters encoded. Service-linked
roles only exist in real accounts, where AWS creates them automatically for ELB,
EKS, Auto Scaling, Trusted Advisor and a dozen other services. The fixture could
not express the shape that broke.

That is the third time (#29, #30, #37). Each time the mock was adversarial about
everything I had thought of and silent about a category I had not.

**Why no test could have caught it either.** `server.ts` created the Fastify
instance and called `listen()` at module scope, so importing it bound a port. No
test could issue an HTTP request at all — every test in this repository went
straight to the query layer or the analysers, and the router was never exercised.
A whole tier of the system had no test surface.

**Fix.** Three parts, because the bug had three causes.

- `maxParamLength: 2048`, reasoned against IAM's documented maxima rather than
  picked round: a role path may be 512 characters and a role name 64, so the
  longest legitimate IAM ARN is about 600 raw. The default is a routing
  performance guard, not a security control.
- `buildApp()` extracted into `app.ts`, with `server.ts` reduced to
  build-migrate-listen. The HTTP layer is now injectable.
- The fixture gains `AWSServiceRoleForElasticLoadBalancing` at
  `/aws-service-role/elasticloadbalancing.amazonaws.com/`, so the mock contains
  the shape that broke, and the answer key names it so deleting it fails a test.

**A detail the verification turned up.** My first version of the test asserted
the _encoded_ length exceeded 100, and one of its three cases passed even with
the cap restored to 100. Fastify measures the **decoded** parameter: a
95-character ARN that encodes to 109 sails through. So one third of the suite was
proving nothing, and I only noticed because I re-ran it against the reintroduced
bug and saw a green row that should have been red.

The first attempt at _that_ check was also wrong — a `sed` whose pattern assumed
two-space indentation silently matched nothing, so the "broken" run was actually
the fixed code and everything passed. Two layers of verification theatre in one
sitting.

**What to take from it.** The lesson is not about Fastify's default. It is that
**verifying a guard fires is itself an operation that can silently fail**, and
the failure looks exactly like success. #23 and #27 are entries about guards that
could not fire; this is an entry about a _check_ on a guard that could not fire.
The defence is the same one that keeps working: make the thing fail on purpose
and look at the actual output, rather than at the exit code.

**Postscript: the fix broke CI, for a related reason.** The routing test issues
real HTTP requests, so the handler runs, so it reads Neo4j. That is deliberate —
a routing test that stubbed the handler would not prove the route is reachable in
the product. But I put it in the unit job, whose entire design is that it needs no
infrastructure. Every request spent thirty seconds discovering there was no
database, and a three-minute job became five.

It passed locally because the databases are running on this machine — the same
shape as the bug it was written to catch, where the author's environment silently
supplies what the test depends on. Split in two: a config assertion that reads
`maxParamLength` off the app Fastify actually built, which needs nothing and runs
on every commit, and the HTTP suite gated behind `SKIP_INTEGRATION` and run in the
job that has the compose stack. The unit job is back to 1.6 seconds.

Worth stating as a rule, because it is the third variant of one idea in this
entry alone: **a test that passes only in the author's environment is not a
test, it is a coincidence** — and that applies to the test, to the check on the
guard, and to the guard itself.

---

## #38 — Two tools told the user their own source code

**Problem.** The chat header answers "what is the agent doing" by naming the
running tool in plain language: `Tracing network paths`, not
`find_network_paths`. Fourteen of the sixteen tools did. The other two —
`find_unprotected_buckets` and `suggest_remediation` — rendered as
`Running find_unprotected_buckets`, which is the raw identifier the label map's
own comment says is not user-facing copy.

**Why it survived.** Both tools were added after the map was written
(ADR-012 and ADR-014), and the map has a fallback. The fallback is the problem:
it produces something plausible, in a status line that flashes past in well under
a second, in the one part of the UI nobody re-reads because it is transient by
design. Every ingredient of an invisible defect.

I did not find it by looking at the UI. I found it while checking a sentence I
had just written in the README — that the product names tools in plain language —
against the code, because the README makes claims a grader will test. The audit
of the prose found the bug in the product.

**Fix.** Both labels added, and `agent/toolLabels.test.ts` now compares the tool
definitions in `agent/tools.ts` against the `TOOL_LABELS` keys in `Chat.tsx` in
both directions: a tool with no label fails, and a label for a tool that no
longer exists fails too, since that usually means a rename left dead copy behind.
Proven by deleting a label and watching it name the right tool.

It reads the web component as text from the API's suite because
`vitest.config.ts` does not include `apps/web` — one cross-workspace file read is
cheaper than standing up a second test runner and a DOM environment for a single
assertion. The cost of a guard is part of whether it gets written.

**What to take from it.** A default that produces something _plausible_ hides a
gap better than one that produces something broken — the fourth entry on that
theme (#17, #28, #31, #36), and the mildest, which is the point: the same shape
that lost every `.env` variable on Windows also costs two words in a status line,
and neither announces itself.

The other half is a method rather than a bug: **documentation that makes specific
claims is a test suite you run by hand.** "Names the running tool in plain
language" is falsifiable, so checking it found a defect. Prose that had said
"clear progress indication" would have checked nothing, because nothing could
have contradicted it.

---

## #39 — Two tenants, one ARN, one node

**Problem.** Adding tenancy to the graph looked like a filtering exercise: put
`tenantId` on every node, add it to every query, done. The behavioural test
written to prove that worked — two tenants projected into one graph, every
curated query run as one of them — failed on a case I had added almost as an
afterthought: a relationship that crossed from one tenant to the other.

**Cause.** Node identity. The uniqueness constraint was on `arn` alone, which is
correct for one AWS account and wrong for a shared database. The edge projection
matches its endpoints by ARN:

```cypher
MATCH (a:Resource {arn: row.from})
MATCH (b:Resource {arn: row.to})
CREATE (a)-[r:TYPE]->(b)
```

With two tenants holding the same ARN, that matches whichever node exists — so
tenant B's relationship attaches to tenant A's node. Not a query bug that a
missing filter caused, and not one a filter could fix afterwards: the edge
genuinely exists, and every path query traverses it. "What can reach the
production database?" would answer with another customer's infrastructure.

**And it is not a contrived case.** Two tenants share an ARN the moment either
of these happens, both of which are ordinary:

- the synthetic `Internet` node, whose ARN is a **constant** — so this occurs
  for every pair of tenants, immediately, on the node that every reachability
  path starts from;
- two customers connecting the same AWS account, which is what a managed service
  provider does on their first day.

**Fix.** Identity is `(tenantId, arn)`: a composite uniqueness constraint —
which Neo4j Community does support, checked before relying on it, since node
_key_ constraints are Enterprise-only — and both endpoints matched on tenant and
ARN. The old single-column constraint is dropped explicitly rather than left
behind, because it would reject the second tenant to hold a given ARN.

**What to take from it.** The two lexical guards I wrote first — every query
binds `$tenantId`, `readQuery` refuses one that does not — both passed the whole
time. They are guards on _queries_, and this was a defect in _writes_. A filter
cannot exclude a row that should never have been connected in the first place.

That generalises past this bug: **isolation is a property of how data is
written, not only of how it is read.** The read-side guards are still worth
having, and they are still the cheap ones, but the only guard that found this
was the one that put two tenants in the same database and looked at what came
back. Third time in this project that a test which merely restated the code's
own assumptions proved nothing (#29, #30, #37) — and the first where the
assumption was mine, written the same afternoon.

---

## #40 — A queue test that passed with the queue's guarantee removed

**Problem.** `scan_jobs` promises one active scan per tenant, enforced by a
partial unique index rather than by application code — the whole point being
that two API replicas cannot both believe they are the only one. The tests
looked thorough: enqueue twice, enqueue four times concurrently, check only one
job exists.

Then I dropped the index and ran them again. **All twelve passed.**

**Cause.** Every test went through `enqueueScan`, which reads before it writes.
In a single Node process, with a connection pool and `await` points, those reads
and writes interleave politely enough that the application check alone produces
the right answer. The tests were exercising the check, not the constraint — and
the check is precisely the part that stops working when there are two processes,
which is the only situation the index exists for.

**Fix.** A test that writes directly, around the application path: insert one
queued job, then insert a second active one, and expect Postgres to raise
`23505`. That one fails immediately when the index is missing, which I confirmed
the same way — by dropping it.

**A second thing the index needed.** A worker killed mid-scan leaves a row
marked `running` for ever, and the uniqueness index then refuses every future
scan for that tenant: one crash, and that customer can never scan again.
`reapStuckJobs` releases them, with a message that says what happened and that
nothing in their account was changed. The guarantee and its failure mode arrived
in the same commit, which is the only reason the second one was noticed.

**What to take from it.** This is the fourth variant of one idea (#29, #30,
#37, #39): **a test that cannot distinguish the mechanism from a coincidence is
not testing the mechanism.** The distinguishing move is always the same and
always cheap — remove the thing under test and confirm the test notices. It has
now caught: a fixture that shared the code's blind spot, a check on a guard that
silently matched nothing, a read-side guard that could not see a write-side
defect, and now an application path that impersonates a database constraint.

---

## #41 — Every tenant was shown the operator's AWS account

**Problem.** Reported within a minute of the first real Google sign-in: a
brand-new tenant, with nothing connected, was looking at the operator's own AWS
account.

**Cause.** Two pieces of ambient state, the same mistake one layer apart.

`activeConnection()` reads `AWS_TARGET_ROLE_ARN` from the environment. That is
correct for a single-tenant deployment — it is how the whole project has
worked — and in a process serving many tenants it means _everyone_ gets the
operator's account.

Worse, and not yet observed because nobody had scanned: `credentials.ts` held
**one module-level cached STS session**. The first tenant to scan would
populate it, and every tenant after that would be handed credentials for that
tenant's AWS account until it expired. Tenant isolation in the database is
irrelevant if the credentials are shared.

**Fix.** `resolveConnection(tenantId)` reads the tenant's own row and never
falls back to configuration — a missing connection is a refusal, not a default.
The session cache became a `Map` keyed by tenant, with the stampede protection
kept per tenant. Every AWS client factory now takes a `TenantId`, so a client
cannot be constructed without naming whose account it will talk to, and the
endpoint moved onto the assumed session for the same reason.

**What made it findable.** Signing in. Every test passed before and after the
bug existed, because they exercise functions rather than a running process with
two tenants in it. The tenant-isolation work had been careful about _queries_ —
three guards, one of which found a genuine cross-tenant edge — and completely
silent about _credentials_, which is the layer where "whose account" is
actually decided.

**What to take from it.** Two things.

**Isolation has layers, and guarding one proves nothing about the others.**
#39 was isolation in writes rather than reads. This is isolation in
credentials rather than in data. Each time, the guards that existed were
correct and aimed somewhere else.

**Ambient state is the shape of the bug.** A module-level cache, a module-level
flag, an environment variable read deep in a call stack — all three are the
same defect: a value that is right when there is one of something, and silently
wrong when there are many. The fix is the same each time, and the compiler can
enforce it: make the thing a parameter, and let every call site that forgot it
fail to build. Adding `TenantId` to the client factories produced a list of
exactly the places that had been reaching for an account without saying which.

---

## #42 — A metrics guard that inspected nothing

**Problem.** The rule for metric labels is simple and absolute: no tenant id,
no ARN, no URL — unbounded label values are both a customer-data leak and an
unbounded series count. So the test read every metric out of the registry and
asserted none of them declared a forbidden label.

Then I added a `tenant_id` label on purpose to watch it fail. **It passed.**

**Cause.** `registry.getMetricsAsJSON()` returns `help`, `name`, `type`,
`values` and `aggregator`. It does **not** return `labelNames`. The test read
`(metric as { labelNames?: string[] }).labelNames ?? []` — `undefined`, every
time, for every metric — and then found no forbidden labels in an empty list.

The optional chaining is what made it silent. `?? []` is a perfectly ordinary
defensive idiom, and here it turned "this property does not exist" into "this
metric has no labels", which reads identically to a pass.

**Fix.** Read the declared names off the metric objects themselves, where
prom-client does expose `labelNames`, and add a test asserting the inspection
found labelled metrics at all — so the suite cannot pass by examining nothing.
Both guards were then re-checked by breaking each on purpose: a `tenant_id`
label, and a metric shadowing the registry's default `service` label.

**A real bug found on the way.** The failed-unit counter was labelled
`service`, which is also the registry's default label naming the application.
The metric's own value wins, so a scan failure in RDS would have produced a
series claiming the application was called `rds`. Renamed to `aws_service`,
with a test that refuses any metric declaring `service`.

**What to take from it.** Fifth entry on this theme (#29, #30, #37, #39, #40),
and the first where the vacuum came from a **defensive default rather than a
missing case**. `?? []`, `?? {}`, `|| ""` are how a test stops testing without
looking any different — and the only reliable detector is the same one every
time: break the thing on purpose, and require the test to notice.

The companion habit, now also a test: **any assertion over a collection needs a
sibling assertion that the collection is not empty.**

---

## #43 — The external id shown was not the external id stored

**Problem.** Found by writing a test for the journey rather than for a layer:
sign in, open the Connection panel, save a role, check what happened. Two
consecutive reads of `/api/connection/external-id` returned **different
values**.

**Why that is serious.** The external id is the string the customer pastes
into their CloudFormation stack, and the string this service presents when it
assumes their role. They have to be identical. The panel generated one for
display, the customer deployed a stack containing it, and saving the
connection generated _another_ one to store. The result is `AccessDenied` on a
connection that looks correct from both ends, with nothing in the message
suggesting the two ids disagree — the single most confusing failure this
product could produce, because the customer's stack is right, the role ARN is
right, and the only wrong thing is invisible to them.

**Cause, and the fix.** The id lived on `connections`, so it could not exist
until a role ARN did — but the customer needs it _before_ the role, because it
goes in the stack that creates the role. The display path papered over that by
generating a throwaway.

It now lives on the **tenant**, issued the first time it is asked for and
reused for ever. That is also the right model: an external id identifies this
customer to AWS and does not depend on which role they point at, which is what
AWS's own guidance says. Rotation exists and is deliberate — never a side
effect of editing a role ARN, because a customer whose stack already has the
old one would start failing with no reason to suspect us.

**What made it findable.** Nothing else would have. Every layer was correct on
its own: the generator produces unguessable ids, the store encrypts them, the
route returns one. The defect was that two correct code paths produced
different values for something that had to be one value, which only a test
that _uses the product in order_ can see. The suite had thirty tests around
this feature and not one of them opened the panel twice.

**What to take from it.** **Test the journey, not only the layers.** Layer
tests find defects inside a boundary; this class of bug lives between two
boundaries that are each behaving correctly. The journey test is now eleven
steps — sign in, look, be refused, take an id, paste a bad ARN, save a good
one, check the neighbour cannot see it, explore the demo, and confirm both
tenants still see empty accounts — and it took an afternoon to write and found
a bug in its first run.
