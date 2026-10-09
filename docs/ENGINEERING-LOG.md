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

## #39 — The onboarding page never said which values were the reader's

**Symptom.** Reported, not found by a test: the connection guide "isn't clear
enough on what the user needs to change." Every command on the page is
copy-pasteable and looks finished, so a reader has no way to tell a value that
was computed for them from a value that is a placeholder waiting for theirs.

**What the page got right, and why that made it worse.** It already explained the
two _roles_ — `DaveIoScannerRoleArn` is an input, the stack _creates_ a different
role, and the created one is what `.env` wants — under a heading calling that the
usual mistake. Being right about the subtle confusion while silent on the plain
one is the worst arrangement: the reader trusts the page and still gets it wrong.

**Causes.** Five, found by reading the rendered output rather than the code.

1. **The two _identities_ were never mentioned.** Deploying the stack needs
   _your_ admin credentials in the target account, used once and stored nowhere.
   The trust policy names _this backend's_ principal, permanently. Both are
   "the ARN" in conversation, they differ, and the page explained neither — while
   carefully distinguishing the two roles, which is a strictly smaller problem.

2. **Nothing identified the target account.** Step 3 said "run this against the
   account you want scanned" without saying how to control or confirm which
   account that is. `aws cloudformation deploy` uses the ambient profile, so a
   wrong default creates the role in the wrong account, and the mistake surfaces
   two steps later as `NoSuchEntity` — which reads like a bug in this product.

3. **The one value the reader had to supply was a sentence inside a config
   file:** `AWS_TARGET_ROLE_ARN=<the RoleArn output from step 3, NOT the scanner
principal>`. Correct as prose, useless as a value, and indistinguishable at a
   glance from the three pre-filled lines around it.

4. **`ExternalId=` interpolated a loading string.** `suggestedId` fell back to
   `"generating…"`, so a reader who copied before the fetch resolved deployed a
   stack whose shared secret was the literal text `generating…`, and put the same
   text in `.env`. **That connection then tests green** — both sides agree on a
   secret neither party meant, which is worse than a failure. If the request
   errored it never resolved at all.

5. **No `--region`,** so the command failed outright for anyone whose CLI had no
   default region — with an error mentioning nothing on this page. The server was
   already reporting `homeRegion` and the guide ignored it.

Separately, the intro promised "four steps" while rendering five, and
`codebase-tour.html` had copied the wrong number.

**Fix.** A `Fields` legend under every command block, tagging each value **filled
in**, **you replace**, or **optional** — amber for the reader's, and exactly one
value on the page carries it. A `Before you start` block above the numbered steps
names what you need, runs `aws sts get-caller-identity` with the two fields
annotated (`Account` — the stack is created here; `Arn` — as this identity), and
sets the two identities against each other explicitly. The placeholder is now
shaped like a real ARN, `arn:aws:iam::<your-12-digit-account-id>:role/DaveIoReadOnlyRole`,
so the reader can see that only the account id is theirs. `EXTERNAL_ID_PENDING`
replaces the loading word, and `--region ${c.homeRegion}` is pinned.

Kept _above_ the numbered steps deliberately rather than added as a step zero:
`WALKTHROUGH.md` says "step 4 is the one to talk about" and two PDFs cite step
numbers. New information should not renumber a reference someone is about to read
aloud.

**The guard.** `infra/connectionGuide.test.ts`, six assertions, each broken on
purpose and observed to fail: a renamed CloudFormation parameter, the placeholder
role name drifting from the template's `RoleName` default, the step count
disagreeing with the rendered `<Step>` elements, no value marked as the reader's,
a status word back in a command block, and the region unpinned.

Two of those assertions were wrong before they were right, both for the same
reason — **a check broad enough to catch the bug also caught the fix.** Scanning
the whole file for status words flagged `c.accountId ?? "unknown"` in the status
panel, which is legitimate. Scoping it to the command region then flagged
`EXTERNAL_ID_PENDING` itself, because "pending" is a substring of the constant
that exists to solve the problem. It now strips upper-snake identifiers first and
looks only for lowercase status words and the Unicode ellipsis; the ASCII `...`
is not checked, because doc comments elide real ARNs with it. A guard that fails
on the correct state gets deleted, so its false-positive behaviour is part of the
design, not an afterthought — same lesson as the two failed attempts in the
`admin-users-risk` eval case.

**What to take from it.** Two things.

**Explaining the hard version of a confusion is not evidence you explained the
easy one.** The page spent a bordered callout on scanner-role-versus-created-role
and never said "this command runs in whatever account your CLI points at." The
subtle problem is the interesting one to write about, which is exactly why it
gets written about first.

**A placeholder that renders as plausible text is the same defect as a default
that produces plausible output** — #17, #28, #31, #36, #38, and now this. Here it
is at its worst, because `generating…` on both sides of the trust relationship
does not fail: it succeeds, against the wrong secret. The rule that keeps coming
back is that the broken state has to _look_ broken.

---

## #40 — A spend cap was reported as an agent regression

**Symptom.** The Trust panel, after a routine eval run:

> **17/21 cases passed** · mean F1 0.81, no unsupported citations

The four failures were the last four cases in the array, in order, each with
**0 tools** and a duration under a second. Every other case took five to
fourteen seconds and called at least one tool.

**What it actually was.** Reproduced on the first attempt:

```
400 {"type":"error","error":{"type":"invalid_request_error",
"message":"You have reached your specified API usage limits.
You will regain access on 2026-10-01 at 00:00 UTC."}}
```

The Anthropic account hit its configured spend cap at case 18. Nothing about the
agent changed. A wrong answer still costs a model round trip, so **0 tools in
0.3 seconds is not an answer at all** — that shape is the tell, and it is the
only reason the report was questioned rather than believed.

**Why this was worth fixing rather than explaining away.** Three compounding
defects, and the third is the serious one.

1. **A refused request was scored as a wrong answer.** The runner caught the
   error and recorded `passed: false, f1: 0`, so `summarise()` averaged four
   zeroes into the mean. 0.81 is arithmetically correct and means nothing: it is
   a number about the API's availability wearing the costume of a number about
   answer quality. The right reading is _17 ran, 17 passed, 4 never happened._

2. **The run continued after an error that could not improve.** The cap applies
   to the account, so cases 19, 20 and 21 were always going to fail identically.
   Three wasted round trips, and a page of red that looks like a systemic
   collapse rather than one billing event.

3. **The run was then written to `eval_runs`, replacing the baseline.** That
   table is what the Trust panel reads and what the next run is diffed against.
   So an outage silently overwrote the last real measurement — and because the
   number it produced was _plausible_, nothing announced that the reference point
   was gone. The brief asks "how would you know if a change made it worse?" The
   honest answer, before this fix, was _you wouldn't: a billing event and a
   regression are indistinguishable, and the billing event destroys the evidence._

**Fix.** `errored` on `CaseResult`, set when the case never reached the model.
`summarise()` averages over graded cases only and reports `graded`, `passed`,
`failed` and `errored` separately. `isTerminalApiError()` aborts the run on a
spend cap, quota, rate limit or rejected key — matched on message text, because
Anthropic returns the usage-limit refusal as `400 invalid_request_error`, which
by status code alone is indistinguishable from a genuinely malformed request, and
those two need opposite responses. An incomplete run is **not** inserted into
`eval_runs`; it is written to `evals/results/` with `-incomplete` in the filename,
so the evidence survives without becoming the reference. Exit code `2` for an
incomplete run against `1` for a quality regression, so CI can tell "this commit
made the agent worse" from "the API was unavailable".

`/api/evals/latest` also recomputes the mean from the stored cases and classifies
a legacy `threw:` failure as errored, because a row written _before_ this fix is
still the most recent one on a machine that ran the capped suite — mine reported
17/21 for as long as it stood. The Trust panel renders a third state, `—` with
"did not run", rather than a red ✗.

**The guards.** `evals/summarise.test.ts`. The first test reconstructs the exact
run and asserts that the old arithmetic produced **0.81** while the new reporting
gives 17/17 at F1 1.0 — the bug is pinned by its own number. The third guards the
inverse mistake: dropping errored cases from numerator and denominator without
counting them, so a run that half-executed and half-regressed would look
partially fine. Four more cover the classifier's boundary: it must abort on a cap,
a low balance, a rate limit and a bad key, and must **not** abort on a malformed
request, a model typo, a bad tool schema, or a 529 overload — the one case where
the next question genuinely may succeed. All four proven by restoring the old
behaviour and watching the right test fail.

`isTerminalApiError` lives in `evals/terminalError.ts` rather than in
`cli/evals.ts` for a mundane reason worth recording: that file is a script with
top-level await, so importing it to test a predicate would run the whole eval
suite and spend money doing it. Testability changed where the code lives.

**Two things I got wrong on the way.** The abort message first read _"1 case
errored and 21 of 21 never ran"_ for a run where one case was attempted and
twenty were not — a message about miscounting that miscounted. And while
diagnosing this I ran the suite to reproduce, which wrote its own `0/4` row and
left the Trust panel reporting `0/4` until I deleted it. **The diagnostic
reproduced the defect it was diagnosing**, which is as good a demonstration as
the test is: any command that writes to the baseline is dangerous by default, and
that is now exactly what the fix prevents.

**What to take from it.** **A plausible number is more dangerous than an error.**
Sixth entry on that theme (#17, #28, #31, #36, #38, #39), and the most expensive,
because here the plausible value did not merely hide a gap — it overwrote the
evidence that would have exposed it, and it did so in the one surface whose entire
purpose is telling a user how much to trust the answers.

The generalisation: **a measurement pipeline must distinguish "the thing measured
badly" from "the measurement did not happen."** Collapsing those is how an
availability problem becomes a quality claim, and the collapse always favours the
wrong conclusion, because a zero looks like data.

---

## #41 — The drift note was a blanket amnesty

**Symptom.** Two ground-truth checks showing red in the Trust panel:

```
Only genuinely public S3 buckets are flagged public
  found: northwind-logs-archive, northwind-public-assets (expected northwind-public-assets)

Billable idle resources are found by structural signal
  found: ..., new-unattached-vol, ..., prod-web-2 (expected ... without those two)
```

**They were correct.** `npm run drift` gives `northwind-logs-archive` a wildcard
policy with no public access block, so it really is public; it creates
`new-unattached-vol` attached to nothing and stops `prod-web-2`, so both really
are billable and idle. Every extra name is a resource the checks were _supposed_
to catch. Reproduced here by drifting and rescanning: the same two checks failed
with byte-identical detail.

So the checks worked, the drift detection worked — `drifted: true`, note rendered
— and the panel still read as two defects. Which points at the note.

**The defect.** The note said:

> These checks describe the pristine fixture, so **some are expected to fail** —
> that is them detecting the drift.

"Some" is a blanket amnesty. It excuses every failure in the panel, including one
that has nothing to do with drift. An analyser regression landing while the
account happened to be drifted would be presented to the user as expected
behaviour, in the one surface whose entire purpose is telling them how much to
trust the data. And in the other direction it is no use either: a reader looking
at two red rows and a paragraph saying some failures are fine cannot tell which
ones, so the honest response is to distrust all of them.

Both readings are wrong, and they are wrong in opposite directions from the same
sentence.

**Fix.** Drift is deterministic, so the checks it breaks are knowable.
`DRIFT_EXPECTED_CHECK_FAILURES` in `drift.ts` maps each one to why, declared
beside the mutation that causes it because the two only stay in step if they are
edited together. `/api/evals/ground-truth` annotates each failing check with that
reason or with `null`, and reports `unexplainedFailures`.

The note is now arithmetic rather than a hedge — _"All 2 failing checks are
accounted for by that change"_, or _"explains 1 of 2 failing checks. 1 is NOT
explained by the drift and should be investigated: idle-resources."_ The panel
gains a third state: `◆ expected after drift` in amber with the reason inline,
distinct from a red `✗`. The summary box only softens to amber when **every**
failure is attributed; one unexplained failure and it stays red. Previously any
drift at all softened the whole panel.

**The guards.** Three unit assertions that need no stack — the map may only name
checks that exist, must not be empty, and every reason must actually read as an
explanation rather than a label. Then the one that matters, in
`groundTruth.test.ts`: apply drift, rescan, and assert the set of failing checks
**equals** the declared set, in both directions with the detail in the message. A
mutation added without an entry makes a correct detection render as a defect,
which is this bug; an entry left behind after a mutation is removed makes the
panel excuse a real regression, which is worse. All four proven by breaking them,
including the integration one, which named the check and printed its evidence.

It lives in `groundTruth.test.ts` rather than its own file for a reason worth
recording: vitest parallelises across files, and one suite seeding moto while
another drifts it would make both flaky. It re-seeds in a `finally`, so a failure
does not leave the fixture dirty for whatever runs next.

**What to take from it.** **A caveat that covers everything protects nothing.**
The note was written to prevent a true-positive reading as a bug, and it worked —
but by excusing the entire panel rather than the two failures it could account
for, it also silenced the case it was never meant to cover. A disclaimer wide
enough to be always true is indistinguishable from no information, and on a trust
surface that is worse than a false alarm, because the reader stops reading it.

The narrower version of the same lesson as #39: the fix there was marking _which_
value the reader supplies, not stating that some values need supplying. Both bugs
were a correct general statement standing in for a specific one, and in both cases
the specific one was mechanically derivable from data the system already had.

---

## #42 — A trust policy condition that no legal value could satisfy

**Symptom.** None. Nothing failed, no test went red, and the feature had been
described in an ADR, in the CloudFormation template's own comments, and in the
onboarding UI. It surfaced only because I was asked to explain in plain language
what `sts:SourceIdentity` does, and went to read what the code actually sent.

**What was wrong.** Three things, each hiding the next.

1. **Nothing sent a SourceIdentity.** `aws/credentials.ts` set `RoleSessionName`
   and stopped. So the claim "the customer's CloudTrail records which dave.io
   operator triggered a scan" was true of the template and false of the product.

2. **The trust policy permitted it without requiring it.** The `AssumeRole`
   statement was conditioned only on `sts:ExternalId`; a separate statement
   allowed `sts:SetSourceIdentity` and constrained its shape. A caller that
   simply omitted SourceIdentity was still allowed to assume. Permitting a
   control is not applying it.

3. **The constraint was unsatisfiable.** The condition was
   `StringLike: sts:SourceIdentity: "daveio:*"`. AWS restricts SourceIdentity to
   "upper- and lower-case alphanumeric characters with no spaces… underscores or
   any of the following characters: `+=,.@-`" — verified in the AWS SDK's own
   bundled API documentation, `@aws-sdk/client-sts` `models_0.d.ts`. **A colon is
   not in that set.** So no value AWS would accept could ever match the pattern.

Stack those and you get the worst version: had the attribution ever been wired up
as written, every `AssumeRole` would have been rejected — and because (1) meant it
was never wired up, (3) could not be discovered by running anything. A control
documented in three places, enforced nowhere, and impossible as specified.

**Fix.** `SourceIdentity` is now sent on every `AssumeRole`, built by
`toSourceIdentity()` from a new `SCAN_OPERATOR` variable: sanitised to AWS's
charset rather than validated-and-rejected, because an operator name with a space
in it should not fail every scan, truncated to the 64-character limit, and never
empty. The template's pattern is `daveio-*`, and the `AssumeRole` statement gains
`Null: { sts:SourceIdentity: "false" }`, which makes attribution mandatory —
omitting it now fails loudly rather than silently losing the audit trail.

**The guard.** `aws/sourceIdentity.test.ts` is a cross-artefact test, because the
bug lived in the gap between two artefacts that were each internally consistent.
It asserts that the value the code sends matches AWS's documented charset and
length, that it matches the prefix the deployed trust policy will enforce, that
**the prefix is itself legal for AWS** — the assertion that catches the original
directly, since `daveio:` satisfies a naive "does the code match the template"
check while being impossible to send — and that the template makes the key
mandatory rather than optional. Seven sanitising cases cover a space, a colon,
slashes, whitespace only, illegal characters only, an already-legal email, and an
over-long name. All four invariants proven by restoring each original defect.

**Two mistakes in the test itself,** both worth recording because they are the
same mistake twice. The prefix extractor took the _first_ `sts:SourceIdentity`
match in the template — which, after adding the `Null` condition, is the literal
string `"false"`, so it compared the code's prefix against a requirement flag. And
the sanitising cases tried to re-import the config module with a query string to
pick up a changed environment variable, which vitest cannot statically resolve.
The fix for the second was the better design anyway: extract a pure
`toSourceIdentity(operator)` and test that, leaving `sourceIdentity()` as the
thin wrapper that reads frozen config. **Testability decided the shape of the
code, again** — same as `isTerminalApiError` in #40.

**What to take from it.** **Documentation is not enforcement, and this is the
sharpest example in the log.** The ADR was right, the template comment was right,
the onboarding copy was right, and the mechanism did not exist. Worse, the one
place that _looked_ like enforcement — a `StringLike` condition in a trust policy —
was itself impossible to satisfy, so even a reviewer checking the template would
have read it as working. Nothing short of sending a real value could have
falsified it.

Second: **a condition that can never match is indistinguishable from no condition
at all**, right up until the day something depends on it. The same shape as #44's
`secretsConfigProblem()` called by nothing but its own tests, and #38's tool
labels falling through to a working default — but more dangerous, because the two
earlier cases degraded to something visibly wrong, and this one degraded to
silence in an audit trail a customer was told to rely on.

---

## #43 — A healthcheck that could never pass on a server that worked

**Context.** Added a second way to run the project: `docker compose --profile app
up -d` brings up the API and an nginx container serving the built frontend, so a
reviewer needs no Node on the host. Opt-in on purpose — the default
`docker compose up -d` still starts exactly the three dependencies it always
did, because a new path misbehaving on a platform I cannot test must not break
the documented one.

**Symptom.** `dependency failed to start: container daveio-api is unhealthy` —
and `web` therefore refused to start at all. Meanwhile the API's own log said:

```
Server listening at http://127.0.0.1:3000
Server listening at http://172.19.0.5:3000
AWS mode: mock
```

The process was alive, `ps` showed it running, and it had bound two addresses.
Docker had marked it unhealthy anyway, with an empty healthcheck output and exit
code 1 — the least informative failure available.

**Cause.** The healthcheck probed `http://localhost:3000`. Inside that image:

```
# getent hosts localhost
::1               localhost  localhost
```

`localhost` resolves to IPv6 loopback, and Fastify bound to `0.0.0.0` listens on
**IPv4 only** — both addresses in the log are v4. So `wget` connected to `[::1]`
and got a connection refused, forever, against a server that was serving
perfectly. Probing `127.0.0.1` from the same shell returned the health JSON
immediately.

**Fix.** `127.0.0.1` in the healthcheck, with the reason in a comment beside it,
since the next person to write a healthcheck in this file will reach for
`localhost` exactly as I did.

Worth noting what did _not_ need changing: the Neo4j and moto healthchecks both
use `localhost` and have always passed. Their images resolve it differently, or
their servers bind dual-stack. So the bug is not "never use localhost in a
healthcheck" — it is that the resolution and the bind have to agree, and nothing
in either image tells you whether they do.

**Two other things this path needed, both the same shape.** Every connection
default in `config.ts` is `localhost` — correct on a laptop, wrong inside a
container. Rather than a second env file that would eventually disagree with the
first, the container hostnames are set in the compose service's `environment:`
block, which takes precedence over `env_file`, so `.env` stays the single source
of truth. And nginx needs `proxy_buffering off` on `/api`, because scans and
agent answers are server-sent event streams: a buffering proxy delivers the whole
stream at the end, which removes the live progress without erroring. The Vite dev
server solves the identical problem in `vite.config.ts`, which is where I went to
find out what nginx would need.

Seeding is a one-shot service with
`depends_on: { seed: { condition: service_completed_successfully } }` rather than
an API entrypoint step, because `seed()` calls `resetMoto()` first: running it on
every API boot would wipe the account whenever the container restarted, and the
next scan diff would report every resource as new.

**Verified, not assumed.** The CI job drives the product through nginx rather
than the API directly: the SPA is served, a deep link falls back to it, the
seeder exited zero, a scan **streams** — asserted by requiring `unit.finished`
events in the response, not merely `scan.finished` — and the graph and findings
come back through the proxy. Locally I also confirmed events arrive a second
before the run completes rather than all at once.

**A second thing the profile broke, found by asking.** `docker compose down -v`
no longer cleans up. Compose removes only the services in the **default**
configuration, so the api, web and seed containers survive — left running against
databases that have just been deleted — and the network cannot be removed
(`Resource is still in use`). `--remove-orphans` does not help either: Compose
v5.5.0 does not treat profiled services as orphans.

So the teardown command is `docker compose --profile app down -v`, which is
harmless when the profile was never started and therefore the only one worth
documenting. Verified all four ways round: profile up then plain down (leaks
three containers), profile up then `--remove-orphans` (still leaks them), profile
up then profile down (clean), and deps-only then profile down (clean).

This is the more instructive half of the entry. The healthcheck bug announced
itself; **this one is silent and leaves the system in a state that looks torn
down.** A convenience added at one end of a workflow changed the meaning of a
command at the other end, and nothing in the change itself pointed there. The
only reason it was caught before a reviewer hit it is that someone asked whether
the old command still worked — which is a better question than it sounds, and the
honest answer needed an experiment rather than a recollection.

**What to take from it.** **A healthcheck is a claim about a system, and it can
be wrong in the direction that says "broken" as easily as the direction that says
"fine".** Most of this log is the second kind — a plausible default hiding a gap
(#17, #28, #31, #36, #38, #39, #42). This is the first kind, and it is much
cheaper: it fails loudly, immediately, and blocks startup. A healthcheck that
wrongly reported _healthy_ would have let `web` start against a dead API and
produced a blank page with no explanation.

The reason it still cost time is that the failure pointed at the wrong layer.
"Container unhealthy" reads as "the application is broken", so I went looking at
the application — which was fine. The empty healthcheck output is what makes this
expensive: Docker reports that the probe failed without reporting what the probe
saw. Running the probe by hand inside the container was the step that took ten
seconds and should have been first.

---

## #44 — Requiring SourceIdentity broke an account that was already connected

**Symptom.** Asked whether the real-AWS connection still worked under the new
containerised setup. It did not — but not for the reason the question implied.

**First cause, and the expected one.** In the container, `Test connection`
returned _"No source credentials were found."_ `.env` carries
`AWS_ACCESS_KEY_ID=mock`, the placeholder, and real mode works **on the host**
through a two-step fallback nobody had written down: `config.ts` strips the
`"mock"` placeholder from `process.env` — it would otherwise shadow real
credentials, which is why that stripping exists — and the SDK's credential chain
then falls through to `~/.aws/credentials`. A container has no `~/.aws`, so the
second step lands on nothing.

Fixed with an opt-in override, `deploy/compose.aws-profile.yml`, that mounts the
host's `~/.aws` read-only. Deliberately a separate file: the path must come from
`${HOME}`, which is not set on every platform Compose runs on, and an unset
variable in a volume spec breaks the **entire** compose file — including the mock
path, which has nothing to do with real AWS. Opt-in costs one flag and cannot
break anyone who does not use it. The alternative, real long-lived keys in `.env`,
is worse in a project whose argument is scoped temporary credentials.

**Second cause, which I had caused two commits earlier.** With the profile
mounted, the assume got further and was refused: _"The role exists but refused to
be assumed."_ Reading the deployed trust policy explained it:

```json
"Sid": "AllowDaveIoScannerToSetSourceIdentity",
"Condition": { "StringLike": { "sts:SourceIdentity": "daveio:*" } }
```

That role was deployed from the template **before** #42. Every `AssumeRole` now
sends `SourceIdentity: daveio-system`, `sts:SetSourceIdentity` is a separately
authorised action, and `daveio-system` does not match `daveio:*` — so the action
is denied and the whole assume fails.

Which is also the cleanest possible proof that #42 was a real bug rather than a
tidy-up: **that deployed policy can never accept a request that sets a
SourceIdentity**, because AWS forbids a colon in the value. It sat there looking
like a working control for as long as nothing exercised it, and the moment
something did, it refused every call.

**The cost is the one ADR-007 already named.** Scoping a trust policy precisely
means the customer has to redeploy when the contract changes. I wrote that as an
accepted trade-off in an ADR and then experienced it as a broken connection two
days later, which is a fair summary of what accepted trade-offs feel like in
practice.

**What I changed, and what I deliberately did not.** `diagnose()` now names this
as a third cause of `AccessDenied`, quoting the value the scanner sends and the
pattern an older stack matches, because the denial itself says nothing about
SourceIdentity and the obvious readings — wrong principal, wrong ExternalId —
are both wrong here.

What I did **not** do is make the scanner retry without a SourceIdentity on
`AccessDenied`. It would have fixed this instantly and quietly made attribution
optional again, which is the whole thing #42 existed to prevent. A fallback that
silently drops a security property is worse than the error it removes.

**A third thing, found while testing the first two.** `docker compose restart api`
does not pick up an edited `.env`: it restarts the existing container, whose
environment was resolved when the container was created. `docker compose
--profile app up -d api` recreates it and does. Verified both ways by flipping
`AWS_MODE` and reading `/api/health`: after `restart` it still reported `real`,
after `up -d` it reported `mock`.

That matters because the Connection screen's step 4 says _"restart the API"_, and
`restart` is exactly the command a reader would reach for — one that appears to
succeed and changes nothing. Both the screen and the README now name `up -d api`
and say why `restart` fails.

**What to take from it.** **A control nothing exercises is not a control, and
making it real is a breaking change.** #42 found a condition that could never
match; fixing it turned a decorative clause into an enforced one, and every
already-deployed stack was relying on it being decorative. The lesson is not
"don't fix it" — it is that enabling a dormant guarantee is a migration, and
should be planned like one rather than discovered by the next person who tries to
connect.

The narrower one, for the third finding: **"restart" meaning "reuse the old
configuration" is a trap that only exists because the word is borrowed.** Nothing
in the name suggests the environment is frozen at create time, and the command
exits zero.

---

## #45 — The documented restart command dropped the credentials it needed

**Symptom.** Asked, before merging, what the sequence actually is: bring the
containerised app up, then restart the API to pick up a real-account `.env`. Two
answers, and the second was a defect I had written into the README the day before.

**First, a misconception worth correcting because the docs invited it.**
`docker compose up -d` does **not** start the app. It starts the three
dependencies, exactly as it always has — the whole point of making the profile
opt-in. The app needs `docker compose --profile app up -d`. The README said so in
one place and then discussed "the containerised path" elsewhere as if `up -d` were
enough, which is the kind of gap that only shows up when somebody follows it.

**The real defect.** The documented way to give the container real credentials was
a pair of `-f` flags:

```bash
docker compose -f docker-compose.yml -f deploy/compose.aws-profile.yml \
  --profile app up -d
```

That works. Then the next thing the README told the reader to do — recreate the
API to pick up an edited `.env` — was:

```bash
docker compose --profile app up -d api
```

No flags. So Compose recreated the container from the base file alone, **silently
dropping the `~/.aws` mount**, and the connection test reported _"No source
credentials were found"_ for a setup that had worked sixty seconds earlier.
Verified exactly that way: mount present, edit `.env`, run the documented restart,
mount gone, credentials gone.

The two instructions were each correct and the pair was not. A reader following
them in order breaks their own working setup, and the error blames credentials
rather than the command that removed them.

**Fix.** `COMPOSE_FILE` in `.env`, commented out by default:

```bash
COMPOSE_FILE=docker-compose.yml:deploy/compose.aws-profile.yml
```

Compose applies it to **every** invocation, so there is no longer a command that
can forget the override. Confirmed: with it set, the same
`--profile app up -d api` that previously dropped the mount now keeps it, and the
connection gets far enough to fail on the deployed role's stale SourceIdentity
pattern instead (#44) — a different, honest error.

Left commented because uncommenting it makes every compose command mount
`${HOME}/.aws`, including the mock path for someone who never touches real AWS, on
platforms where `HOME` may not be set at all.

**The guard.** `infra/composeAwsProfile.test.ts` ties together three artefacts
that previously had nothing in common: the `COMPOSE_FILE` line in `.env.example`,
the override file it names, and the README passage telling people to use it. It
asserts the setting is documented as `COMPOSE_FILE` rather than as flags, that
every file it names exists, that it stays commented out, that the mount is
read-only and touches only the `api` service — the seeder in particular must never
get real credentials, since it writes — and that the README still explains _why_,
not merely what to type. All five proven by breaking them.

One assertion was wrong first, in a way worth recording: it matched a README
phrase with a regex that assumed the words sat on one line. Prettier wraps prose,
so the phrase spanned a line break and the test failed on formatting rather than
on meaning. It now collapses whitespace before matching. **Third time a
cross-artefact test has been defeated by the shape of the file rather than its
content** (#39, #42), and the lesson is the same each time: when a test reads a
document, normalise the document first.

**What to take from it.** **Two correct commands can compose into a broken
procedure, and documentation is where that happens.** Nothing was wrong with
either instruction in isolation; the defect lived in the transition between them,
which is precisely the part no test covered and no reviewer reads as a unit. The
fix was not better wording — it was removing the state the reader had to carry
between commands. A setting in a file cannot be forgotten on the next invocation;
a flag can.

Second, smaller: **"restart" and "recreate" are different operations and only one
of them reads configuration.** `docker compose restart api` exits zero and
silently reuses the environment frozen at create time (#44). Both failures in this
pair come from a command that succeeds while doing less than its name suggests.

---

## #46 — The legend said "filled in" above a placeholder

**Symptom.** A real deployment, on a second machine:

```
aws cloudformation deploy ... DaveIoScannerRoleArn=arn:aws:iam::672299759593:role/DaveIoScanner
aws: [ERROR]: Failed to create/update the stack.
```

`describe-stack-events` gave the reason:

```
Invalid principal in policy: "AWS":"arn:aws:iam::672299759593:role/DaveIoScanner"
```

`role/DaveIoScanner` does not exist in that account. The identity that does is
`user/terraform-bootstrap`. The stack rolled back cleanly, so nothing was damaged
— but nothing about the error says _which half_ of the ARN was wrong, and a reader
who supplied the account id themselves will reasonably assume the account id is
the part being rejected.

**Cause, and it is in the feature built to prevent exactly this.** #39 added a
`Fields` legend under every command block, tagging each value **filled in** or
**you replace**, because handing someone a command without saying which parts are
theirs is how they deploy into the wrong place. Two defects in that work:

1. **`DaveIoScannerRoleArn` was tagged `kind: "filled"` unconditionally**, with the
   note _"the identity this backend runs as"_. But the value is
   `c.scannerPrincipal ?? <fallback>` — when the backend cannot resolve its own
   identity (no credentials, or a container without the profile mount) the command
   carries a **placeholder** and the legend still said it was filled in. The one
   element on the page whose entire job is to distinguish real values from blanks
   was asserting the blank was real.

2. **The fallback marked one blank and hid two.**
   `arn:aws:iam::<account>:role/DaveIoScanner` invites exactly one substitution.
   The account id is visibly a placeholder; `role/DaveIoScanner` is not — it reads
   like a name someone chose. Substitute the marked blank and you get a
   syntactically perfect ARN for a principal that does not exist, which passes the
   template's own `AllowedPattern` and fails in IAM.

Together: the page said the value was correct, and the value looked correct. There
was no signal available to the reader at all.

**Fix.** The fallback marks every unknown segment —
`arn:aws:iam::<account-id>:<role-or-user>/<name-of-this-identity>` — so no partial
substitution can produce something plausible. The legend branches on
`principalUnresolved`, reading _"NOT filled in — this backend could not work out
its own identity"_ with the command to get it. And the warning above now says
**"Do not run the command above as it stands"** rather than "contains a
placeholder", names the `Invalid principal in policy` error the reader will
otherwise meet, and says the role name is a placeholder too.

**Two guards had to change, and both were wrong in the same interesting way.** The
`kind: "replace"` count asserted exactly one across the whole file; making the
scanner principal _conditionally_ the reader's value made it two, so an assertion
that was only ever true by accident broke on an improvement. It is now scoped to
the `.env` block, where "exactly one value is yours" is a real invariant. And the
no-status-words check fired on the word "unknowns" inside a doc comment explaining
this bug — the guard reporting its own explanation as a defect. It now strips
comments first, because a comment cannot be rendered.

**What to take from it.** **The mechanism that distinguishes real from placeholder
has to be correct in the case where the value is missing — which is the only case
it exists for.** Tagged values were right whenever the backend knew its identity,
and wrong precisely when it did not: the legend was decoration in the working case
and a lie in the failing one. #42 was a trust-policy condition that could never
match; this is a label that could never be wrong when it mattered and never right
when it did.

And the narrower one, which is the third entry on this theme (#17, #28, #31, #36,
#38, #39, #42, #45): **a partially-marked placeholder is worse than an unmarked
one.** Marking the account id told the reader "this is the part to fill in", which
is a statement about the rest of the string. An honest placeholder marks
everything it does not know, or it is not a placeholder — it is a suggestion.

---

## #47 — Three assertions that read comments instead of copy

**Context.** The connection page had reached 613 lines and was reported, fairly, as
_"very confusing, has too much text."_ Rewritten to five steps of one action each,
with the reasoning moved behind native `<details>` disclosures — the argument for
each decision is a click away rather than above the command the reader came for,
and none of it is the only copy, since `docs/DECISIONS.md` carries the same
reasoning.

**What the rewrite broke, and what that revealed.** Two guards failed immediately,
which is the system working. Then I tried to prove the rest still fired by
breaking each on purpose, and **two sabotages came back clean** — the interesting
result, because a guard that cannot detect its own defect is not a guard.

Both had the same cause: **the assertion matched a comment rather than rendered
copy.**

1. The step-count check reads the page's claim about itself and compares it to the
   number of `<Step>` elements. Its regex was case-insensitive, and the rewrite's
   own file header began _"Five steps, one action each"_. So it matched the
   comment, got 5, and passed while the rendered sentence said four.

2. The container-only credentials note was verified by finding the text and then
   scanning **backwards** for the nearest `{c.containerised && (`. The rewrite
   introduced an unrelated `c.containerised` earlier in the file — one line about
   credentials inside step 1's warning — so removing the real guard still left the
   search satisfied.

This is the third time (#39, #42, #45) a cross-artefact test has been defeated by
the _shape_ of a file rather than its content. The earlier two were fixed locally,
one assertion at a time.

**Fix, structural this time.** Each test file now derives a comment-stripped copy
of the component once, and every assertion about what the page _says_ reads that
instead of the raw source. And the container-only content moved into a named
`ContainerCredentialsNote` component, so its guard is asserted by **call site** —
exactly one call site, and that site must be preceded by `c.containerised &&` —
rather than by a backwards search that any similar-looking line can satisfy.

**What to take from it.** **A test that reads source has to decide which parts of
that source are the product, and it will not decide correctly by accident.**
Comments are the obvious non-product part and were repeatedly matched anyway,
because each assertion was written against the file as it looked that day. The
fix that finally holds is not a better regex: it is normalising the input once,
where a future assertion inherits it, and giving the thing being guarded a name so
it can be found directly instead of inferred from proximity.

Proximity is the weaker idea of the two. "The nearest guard above this text" is a
guess about structure that happens to be right until the file grows, and a file
that is being simplified grows in exactly the places that break it.

---

## #48 — "Provide credentials" was the whole diagnosis

**Symptom.** Reported by someone following the new five-step onboarding on a fresh
Windows machine:

```
No source credentials were found.
In AWS_MODE=real the standard AWS credential chain is used.
Provide credentials, or an instance or task role.

CredentialsProviderError
```

Accurate, and useless. They _had_ provided credentials, by one of the two routes
the page offers.

**Why it was useless.** `CredentialsProviderError` means "nothing in the chain
produced credentials". In a container that has at least three distinct causes,
each needing a different fix, and **none of them is visible from outside the
container**:

1. No keys in the environment and no profile mounted.
2. The mock's placeholder still in `AWS_ACCESS_KEY_ID`. It is deliberately
   stripped from `process.env` at startup — being first in the SDK's chain it
   would otherwise shadow everything else — so the reader has set a variable, the
   warning about it scrolls past in the container log they are not watching, and
   the effect is identical to not setting it.
3. A profile mounted from the wrong host path. On Windows this is what an unset
   `HOME` produces: Compose resolves `${HOME}/.aws` to `/.aws`, the mount
   succeeds, and the directory is empty (#45).

A reader cannot tell these apart by inspection, and the message invited the one
action — "provide credentials" — that they had already taken.

**Fix.** `credentialSources()` reports what the chain actually has: whether a key
is set, whether it is _shaped_ like a real one, whether the profile directory
exists, and which files are in it. Presence and shape only, never a value — a
diagnosis that leaks half a secret into a UI is not an improvement, and that is
asserted rather than intended. `diagnose()` renders it as a "What was checked"
line, and the remedy branches on whether the API is containerised.

The three failure modes now read:

- _AWS_ACCESS_KEY_ID is not set; no ~/.aws profile directory at all, so no profile
  was mounted_
- _AWS_ACCESS_KEY_ID is set but is not shaped like a real key (real ones start
  AKIA/ASIA), so it was removed to stop it shadowing the rest of the chain_
- _a ~/.aws directory exists but is EMPTY, which means the mount resolved to the
  wrong host path — on Windows that is an unset HOME, so set AWS_PROFILE_DIR_

All three reproduced in the container before and after, and the success path
re-checked: with a real profile mounted the error moves on to `AccessDenied`,
which is the deployed role's stale trust policy (#44) and no longer a credentials
problem.

**Two guards missed, both conditional on state that cannot occur.** This is the
part worth recording.

The empty-versus-absent assertion was written as _"if there are files, the
directory must exist"_ — true, trivial, and untestable on a machine with a
populated `~/.aws`, which is every machine I run tests on. It passed while the
distinction it guards was removed. It now builds real directories in a temp home
and checks all three states.

The placeholder assertion was conditioned on seeing `AWS_ACCESS_KEY_ID=mock` in
`process.env` — which **the code under test deletes at import time**, that being
its entire purpose. The condition was never true, so the assertion never ran. The
shape check is now a table-driven test of an exported pure function, for the same
reason `toSourceIdentity` (#42) and `isTerminalApiError` (#40) are separate
functions: a branch reachable only through frozen module state is a branch no test
will reach.

And one sabotage of my own was wrong: I widened the key regex's character class to
accept lowercase, and nothing failed — because lowercase is rejected by the
_prefix alternation_, not the character class. The realistic regression is adding
an `/i` flag, which does fire. **Breaking a guard tells you nothing unless you
broke the thing it guards.**

**A follow-up, from the same reader hitting the improved message.** It read:

> _AWS_ACCESS_KEY_ID is set but is not shaped like a real key (real ones start
> AKIA/ASIA), so it was removed_

Better, and still one step short: "not shaped like a real key" covers both _"you
have not replaced the placeholder"_ and _"the value you pasted is wrong"_, which
need different actions. Describing the shape of a value the reader never chose is
a description of the wrong thing.

Before assuming, I checked what could mangle a genuine key on Windows, since
that is where this was reported. Compose's `env_file` handles all three
candidates cleanly — `cat -A` on the container's own environment shows quotes
stripped, a trailing space stripped, and **CRLF stripped** — so none of them was
the cause, and the value really was a non-key.

So `credentialSources()` now reports `envKeyIsMockPlaceholder` and `envKeyLength`,
and the message splits:

- _AWS_ACCESS_KEY_ID is still the placeholder "mock" that .env.example ships — it
  has not been replaced_
- _AWS_ACCESS_KEY_ID is set (38 characters) but does not start AKIA or ASIA …
  check you pasted the access key id rather than the secret_

Length, never the value. A test asserts the constant matches what `.env.example`
actually ships, because a message naming a string the reader has never seen is
worse than a vague one.

**What to take from it.** **An error message is a diagnosis, and a diagnosis that
lists every possible cause is a diagnosis of none of them.** This project already
argued that for AWS failures — `AccessDenied` versus "the trust policy does not
name this principal" (#28) — and then shipped the generic version for the
credential chain, which is the first thing a new user meets. The fix was not
better wording: it was _looking_, and reporting what was found.

Second: **a conditional assertion is a test that may not exist.** Both misses here
were `if (something) expect(...)`, where the condition depended on ambient state.
The pattern is seductive because it makes a test pass everywhere; that is also
exactly what makes it worthless. If a branch needs particular state, the test has
to construct it.

---

## #49 — Two bugs found by testing my own script, and one visible in its output

**Context.** Four defects reached a user following the connection steps on a second
machine, each a product bug rather than their mistake. The conclusion was that
hand-editing `.env` and copying a CloudFormation command is too many chances to be
wrong, so `npm run setup` now does it (ADR-015).

A script that writes someone's configuration and deploys to their AWS account has
to be held to a higher standard than the thing it replaces, so this records what
testing it found — including the part where I was wrong about my own plan.

**What I got wrong first.** The proposal on the table was a **form in the product**.
It would not have worked, and I only saw why when I checked what the container can
reach: the API has no AWS CLI, no permission to create an IAM role, and no access
to the `.env` on the host. A form could have collected a role ARN into a database;
the reader would still have run the CloudFormation command by hand, which is
exactly where the four failures were. It would have removed the smaller half of the
work and cost a rewrite of ADR-010 to do it.

The suggestion that replaced it — a script — is better for a reason worth stating:
**it runs where the capability already is.** The user's AWS CLI, their SSO session,
their `.env`, their Docker. No new endpoint, no authentication question, ADR-010
untouched.

**Bug 1: the script appended a new heading every run.** `applyEnvEdits` writes
unknown keys under a `# --- written by npm run setup ---` marker. A second run that
added a _different_ key appended a _second_ marker, so a user's `.env` accumulated
one block per run. Nothing broke — which is why it would have gone unnoticed
indefinitely. It just quietly degrades a file the script promised to treat
carefully. Found by a test asserting the marker appears once; it now appends under
the existing one.

**Bug 2: the script rotated a working secret.** It generated a fresh ExternalId on
every run. The stack's trust policy requires the value `.env` holds, so re-running
would have invalidated a connection that worked until the stack was redeployed with
the new value — **the script breaking the setup it had just made.** Caught by
running `--dry-run` twice and noticing an ExternalId change on a deployment that
was already correct. `chooseExternalId()` now reuses one in use, and only treats
the shipped placeholder as absent.

**Bug 3, visible in the first successful run.** It wrote `.env` twice, with two
confirmations and two backup files, because the profile mount was decided _after_
the connection was written. One operation, two mutations, two chances to be
interrupted half-done. Containerisation is now resolved before the edits are built,
and it is one write.

**What testing the failure paths found.** Nothing, which is the point of recording
it. Duplicate keys, absent credentials, an unusable AWS CLI and a failed deploy all
stop with an actionable message, exit non-zero, and leave `.env` byte-identical —
verified by sha256 before and after each. The deploy failure quotes
CloudFormation's own reason _and_ explains it, because the alternative is what a
user hit for real: `Invalid principal in policy`, which names neither which half of
the ARN was wrong nor how to find the right one.

**Two of my own sabotages were wrong,** and both times the guard was fine. A PATH
without `aws` also had no `node`, because both live in `/usr/bin` on this machine;
and a non-executable `aws` stub earlier in PATH is _skipped_ by the OS, which then
finds the real one. A stub that is executable and exits non-zero is the test that
actually exercises the branch. **Breaking a guard proves nothing unless the break
reached the thing it guards** — the third time that has come up in this log.

**What to take from it.** **Automation that edits a user's files has to prove its
restraint, not assert it.** The load-bearing piece is not `applyEnvEdits`, which is
tested; it is `untouchedKeys()`, which checks the _produced content_ before writing
and refuses if anything undeclared moved. That is a backstop against a bug in the
tested code, and it costs one function.

Second: **the most dangerous bug in a setup script is the one that succeeds.** All
three found here produced a working outcome — a slightly messier file, a rotated
secret, a duplicated write. None would have surfaced as an error, and two would
have been blamed on something else entirely when they eventually bit: a connection
that "just stopped working" after re-running setup is not a sentence anyone
connects to a heading in a `.env`.

---

## #50 — The secret scanner caught the test that mirrors the secret scanner

**Symptom.** Three CI runs in a row failed the secret scan, each on a different
instance of the same mistake, and the third is the one worth the entry.

**First.** A masking test used `sk-ant-api03-…` as a fixture. This repository's own
gitleaks rule matches that, so the scan failed. The shape was irrelevant to what the
test asserted — masking is decided by the variable **name**, not by whether the
value looks like a credential — so the fixture was simply wrong to write that way.
The lesson was already recorded on another branch ("stop shaping test fixtures like
real Anthropic keys"), and I repeated it, which is the argument for a guard rather
than for care.

**So I wrote the guard:** `setup/fixtures.test.ts` applies `.gitleaks.toml`'s rules
in the unit suite, so the feedback arrives while a fixture is being written rather
than minutes later in CI. It reads the patterns **from** the config rather than
restating them, translating Go's inline `(?i)` which JS rejects, and honours each
rule's own allowlist so documented placeholders are not flagged.

It immediately found a second one, in `.github/workflows/ci.yml`: the step that
checks `.env.example` for a real ExternalId used an `AWS_EXTERNAL_ID=` prefix
followed by a negative lookahead for the two placeholders — which matches the rule
for real ExternalIds. A file describing the check tripping the check. Rewritten as
two greps, verified still to catch a planted secret and still to permit the
placeholder.

**Then the third, which is the interesting one.** gitleaks flagged
`fixtures.test.ts`. Its **positive controls** are credential-shaped strings, by
necessity: a test proving it detects them needs one to detect. Written as literals
that fails the scan for ever, and allowlisting the file instead would silence it on
the day something real is pasted in.

Fixed by assembling the probes at run time —
`["sk", "ant", "a".repeat(22)].join("-")` — which both scanners read as
unremarkable text, because both read text. The comment beside them says not to fold
them back into literals, because a literal reads as simpler and is what the next
tidy-up reaches for.

**And why the guard did not catch itself.** It used `git ls-files`, which does not
list a file that has not been committed. The suite passed locally, the commit
landed, and gitleaks found it a minute later. Now
`--cached --others --exclude-standard`, so a brand-new file is in scope — verified
by planting a literal in an uncommitted file and watching it fail.

**One more turn of the same screw.** Fixing the tree still did not clear CI, because
gitleaks scans a pull request's **commit range**, not its tree: the findings were
reported against the commits that introduced the literals. Both are synthetic and
nothing needed rotating, so two commits are allowlisted **by SHA** — following the
call already made for a genuinely rotated Cloudflare token. By SHA and not by path,
because allowlisting the file would blind the scanner to that file for ever, and
verified by planting a literal and watching both the guard and the scan still
object.

**What to take from it.** **A check that mirrors another check inherits its
blind spots and its trigger conditions.** Every failure here was the scanner working
correctly; the bug each time was mine, in the fixture. That is the good case — but
it cost three CI runs because the fix and the thing being fixed kept overlapping,
and each round the overlap moved: the value, then the file describing the value,
then the test describing the file.

**A fourth instance, in this entry.** The paragraph above originally quoted that CI
pattern verbatim, so committing the write-up failed the guard — a log describing the
bug reproducing the bug. It is now described rather than quoted. Worth recording
because it is the cheapest possible demonstration of the shape: anything that
_discusses_ a credential pattern is itself a file the scanners read.

The narrow, reusable lessons: **a test's fixtures are part of the codebase the
scanners read**, so a synthetic secret is a real liability with none of the danger;
**a guard that reads the repository must decide what "the repository" means**, and
`ls-files` quietly excludes the file you are writing; and **a scanner that reads
history is not satisfied by a clean tree**, so fixing forward and re-running is not
the same as fixing.

---

## #51 — The first command in the README did not run on a clean machine

**Symptom.** On a second laptop, following the README from the top:

```
'tsx' is not recognized as an internal or external command,
operable program or batch file.
```

from `npm run setup -- --anthropic-key sk-ant-...`. Reproduced in three seconds
with `git clone` into an empty directory — the same failure, phrased by the shell
of the day (`sh: 1: tsx: not found`).

**Cause.** `npm run setup` ran `tsx apps/api/src/cli/setup.ts`, and `tsx` is a
devDependency. Nothing had ever run `npm install`, because the README says
"You need Docker. Nothing else" and then hands the reader an npm command. The
containerised path is genuinely self-contained; the npm commands sitting inside
it are not, and nothing in between said so.

**Not one command.** `npm run drift` and `npm run scan` are in the same README
paragraph, three lines above, and fail identically. So does every other script in
the root `package.json`, because all of them resolve a binary out of
`node_modules/.bin` — vitest, prettier, tsc. The bug was in the entire surface,
and only visible on the one command a new reader happens to run first.

**Fix.** `scripts/deps.mjs`: if `tsx` is absent, say so in a sentence and run
`npm install`, then let the real command proceed. Every root script is prefixed
with `node scripts/deps.mjs && `, and a test asserts that every one of them still
is, so a script added later cannot quietly reintroduce this for whoever runs it
first.

**Why a prefix works.** `npm` puts `node_modules/.bin` on `PATH` whether or not
that directory exists, and `PATH` is resolved when a command is executed rather
than when the script begins — so a directory that appears midway through an `&&`
chain is found by the second half. Verified rather than assumed: a probe script
in a fresh clone printed seven `node_modules/.bin` entries on `PATH`, none of
which existed. This is what let the fix be additive. The commands after the `&&`
are byte-for-byte what they were, so no working path changed shape to gain this.

**Three details that are the actual engineering.**

_It probes `tsx`, not `node_modules`._ A tree left by `npm ci --omit=dev` has a
`node_modules` and none of the tooling, which is exactly the case the guard is
for — the cheaper test passes precisely when it must not.

_It checks again after installing._ `npm install` can exit 0 against a tree that
still lacks devDependencies — an `--omit=dev` in someone's `.npmrc` will do it.
Trusting the exit code there would hand the reader back `'tsx' is not recognized`
one step later, which is the error the file exists to replace. It names the
missing path and the likely cause instead.

_It never touches a shell._ On Windows `npm` is `npm.cmd`, and since Node 20.12
`spawn` refuses a `.cmd` without `shell: true` — which would put a command line
back through a parser to run one constant command. `npm` sets `npm_execpath` to
its own JavaScript entry point when it runs a script, so the Node process already
running can execute that directly: one argv vector, no shell, the same on every
platform. Absent that variable, it asks rather than guessing at a binary name.

**And it installs rather than instructing.** The counter-argument is that 259 MB
and a minute or two is a surprise, and this project's rule is to show the plan and
ask first. That rule is about `.env` and about AWS: things outside the repository,
things with a blast radius. `npm install` writes to one directory inside the
folder the reader just cloned, is undone by deleting it, and is the thing they
would have been told to type anyway. Asking would also make the command fail
outright when stdin is not a terminal, which is every CI job and every piped
shell. So it announces, and proceeds.

**Proof.** Five deliberate breakages, each caught by exactly the assertion written
for it: probe `node_modules` instead of `tsx`; drop the post-install re-check;
collapse npm's exit code to 1; guess at `npm` when `npm_execpath` is missing;
remove the guard from one script. Then the real thing, end to end — a fresh
`git clone` with no `node_modules`, `npm run setup -- --mock --dry-run --yes`,
which installed and then printed its plan, and a second run that was silent
because there was nothing to do.

**And then it broke the container, which is the part I did not see coming.** The
fix made every root script depend on a _file_, and the API image does not copy the
whole repository — it copies `packages/`, `apps/api/` and two configs, by design,
so that a code change does not reinvalidate the `npm ci` layer. `scripts/` was not
in that list. The compose `seed` service runs `npm run seed`, so it died with
`Cannot find module /app/scripts/deps.mjs`, and because the API waits on
`service_completed_successfully` the whole `app` profile came down with it — the
one-command path in the README, broken by the fix to the other command in the
README. Caught by CI, three minutes after the commit that caused it.

One `COPY` fixes it. The guard is a no-op inside the image, since `npm ci` there
installs devDependencies deliberately. `infra/dockerfileScripts.test.ts` is the
part worth keeping: it resolves each stage's `FROM` chain, finds every compose
service and `CMD` that runs a _root_ script — workspace-scoped `-w` invocations
resolve elsewhere and are excluded — and asserts the stage copies `scripts/`.
One of its three assertions exists only to prove the other two are looking at
something, because a parser that silently matches nothing passes every test built
on it. All three were verified by breaking them.

**What to take from it.** **A prerequisite you have satisfied is invisible.**
Every command in this repository worked on my machine for the same reason: I ran
`npm install` in week one and never thought about it again. The README was not
written carelessly — it was written from a directory where the claim was true.
The general form is that the first five minutes of a project can only be tested
from a clean machine, and "it works here" is the one piece of evidence that
cannot establish it.

That has a second half here. The container had satisfied it too — `npm ci` runs in
the image — so the only thing missing was the file, and nothing in either the
`package.json` or the `Dockerfile` hints that the other exists. **A guard that adds
a dependency is a change to every environment that runs the guarded thing**, and
the environments that are not your laptop are the ones that find out.

---

## #52 — Building the net before the refactor, and what it caught on the first run

**Context.** The project was reviewed and the feedback was three things: no ORM, no
backend framework, and an LLM loop written by hand — all of which "made it harder
to read". None of that is a correctness complaint. It is a legibility complaint,
and the fix is to move the data layer onto an ORM, the HTTP layer onto a
structured framework, and the agent loop onto a standard SDK, while keeping the
two properties that were worth having: verdicts computed in code, and every ARN in
an answer checked against what the tools returned.

**The problem with that plan.** A refactor of three layers at once is only safe if
something pins the behaviour. The suite had 424 tests and **exactly one of them
issued an HTTP request** — `resourceArn.test.ts`, written to catch a 414 on long
ARNs. Everything else tested functions. So the thing a port is most likely to break
— the shape of what the frontend receives — was the thing nothing asserted.

**The schemas were captured, not written.** Every endpoint was called against a
populated database and its real response recorded, then described in Zod. Writing
the contract from reading the handlers would have pinned what I _believed_ the API
returned, which is the same class of error the refactor is trying to survive. Twice
the capture disagreed with what I expected — `/api/scans/diff` returns two different
shapes depending on whether there is anything to compare, and several `region`
fields are nullable on IAM resources, which is obvious once seen and was not before.

**Three endpoints must not be exercised, and saying so is part of the contract.**
`POST /api/chat` spends money on every run. `POST /api/connection/mode` switches the
deployment between the mock and a real account and drops the cached STS session, so
a test calling it would reconfigure whoever was using the app. `POST
/api/evals/ground-truth` re-seeds the account and runs a full scan. For each, the
_refusal_ is a contract the UI renders, so that is what is pinned, and the entry says
why rather than leaving a reader to think the test is lazy.

`POST /api/scans` is worse: its only refusal is 409 when a scan is already running,
and that flag is module-private, so **no input makes it decline**. It is excluded by
name, in a map that carries the reason and what covers it instead. A second
assertion refuses an exclusion whose reason is shorter than a sentence, because the
cheapest way to silence a completeness check is to add a line to the exclusion list.

**The completeness check found two untested routes on its first run** — `POST
/api/scans` and `POST /api/connection/test`, both of which I had missed while
writing a list I believed was exhaustive. It reads the route table out of Fastify's
own router rather than grepping source, so a route registered by any path is in
scope.

**Proven by breaking it, five ways.** A handler renaming `idleCost` →
`idleCostUsd`; a new route with no contract; a contract naming a route that no
longer exists; an exclusion whose reason is "TODO"; and the `printRoutes` parser
matching nothing. Each failed exactly the assertion written for it, and the last
failed two — the canary that exists to prove the comparison is comparing something,
and the comparison itself, which with an empty parse decided every contract was
stale. That is the right behaviour: a parser that silently matches nothing makes
every check built on it pass.

**Baselines recorded before anything moves:** 390 tests in `verify`, 18 in the
tier-1 ground-truth suite with drift attribution exact, and the stored tier-2 run at
21/21 with mean F1 1.0.

**What to take from it.** **A test suite can be large and still not cover the thing
a refactor breaks.** 424 tests sounds like protection; one HTTP request is what it
actually was, because the suite had grown by testing each new function rather than
each new surface. The useful question before a refactor is not "how many tests are
there" but "which of them would fail if the output changed".

---

## #53 — Adopting an ORM added every foreign key a second time

**Symptom.** None. That is the entry.

The baseline migration applied cleanly to a database with 14 scans and 1414
resource snapshots in it. Nothing errored, no data moved, every test passed, and
the API served the same payloads. The database then had **ten** foreign keys where
it should have had five.

**Cause.** `drizzle-kit` emits plain `CREATE TABLE`, which is correct for a
database that does not exist and fails on the first statement against one that
does. So the baseline was hand-edited to be idempotent: `IF NOT EXISTS` on tables
and indexes, and on the foreign keys the wrapper drizzle-kit itself used to
generate —

```sql
DO $$ BEGIN
  ALTER TABLE "scan_units" ADD CONSTRAINT "scan_units_scan_id_scan_runs_id_fk" ...;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
```

That reads as "add it unless it is already there". It is not what it does. It
catches a collision of **names**, and Drizzle names constraints differently from
the names Postgres generates for one declared inline: `scan_units_scan_id_fkey`
against `scan_units_scan_id_scan_runs_id_fk`. Same columns, same target, same
cascade — different name, no collision, so Postgres added a second one. Every
insert now validated the same foreign key twice.

**How it surfaced.** Not from a test, because no test compared the two paths. I
dumped the catalogue of the migrated database and of one created from scratch and
diffed them, on the general principle that the two ought to be identical. Five
lines of difference, all foreign keys.

**And the first diff lied.** The query used `contype` without a cast, Postgres
rejected it with `operator is not unique: text || "char"`, both dumps came back
empty, and `diff` reported them identical. A comparison of two failures is a pass.
That is the same shape as the migration bug directly above it: something that
reads like a check, succeeding without checking.

**Fix.** The baseline _adopts_ rather than adds. Before the `ADD CONSTRAINT`
statements it renames each constraint an older database already carries to the
name this schema uses — nine of them, including the two primary keys and the two
`CHECK`s, whose names also differed. `undefined_object` is caught, which is the
normal case on a new database. Renamed rather than dropped and re-added, because
re-adding a foreign key takes a lock and revalidates every row while a rename is a
catalogue update.

**The guard.** `src/db/adoption.test.ts` creates two scratch databases, builds one
with the pre-ORM `schema.sql` — kept as a fixture for exactly this — migrates
both, and diffs the full catalogue including constraint names. Names are compared
deliberately: a name is what the next migration will have to say to drop or alter
something, so two databases differing only in names are not interchangeable, and a
name is precisely what this bug got wrong.

Proven by breaking it three ways: remove the foreign-key renames (both the
equality assertion and the dedicated duplicate check fail), remove the primary-key
and check renames (the equality assertion fails), and make the catalogue query
return nothing — which fails the canary that exists because an empty comparison is
how the original diff lied.

**Also worth recording: the write path had no test at all.** `saveScanResult` is a
transaction over three kinds of write, two of them chunked by hand against
Postgres's 65535-parameter cap, and nothing read a scan back and compared it. The
port was the moment to notice. `repository.test.ts` now writes 1200 resources —
past the 500-row boundary, so a bug in the second chunk is in scope — reads them
back and compares by content rather than by count, and asserts the transaction
actually rolls back by failing a row in the second batch. Verified by breaking the
transaction, the chunking, the `'global'` sentinel that stands in for a null
region, and the fingerprint comparison in the diff.

**What to take from it.** **An idempotent migration is not the same as an
adopting one.** "Run this safely twice" and "arrive at the same database from two
different starting points" sound like one requirement and are two, and only the
second is what you actually need when a schema definition changes hands. The
cheap test for it is to build both and diff the catalogue — which is also the only
reason this was ever visible, since the symptom was nothing at all.

---

## #54 — The SDK declined to run a tool, and said nothing at all

**Context.** Porting the agent loop onto the Vercel AI SDK. The port itself was
straightforward — `streamText`, `stopWhen: stepCountIs(8)`, the sixteen existing
JSON schemas handed over through `jsonSchema()` untouched. The work was in the
test, because the whole point of the port was proving that the citation ledger
survives it.

**Symptom.** A scripted model, a stubbed tool, and five failing assertions. The
agent answered `"I wasn't able to reach a conclusion within the tool-call
limit"` — its own fallback for an empty answer. The tool had not run.

**What made it slow to find.** Nothing was wrong. The stream carried a
`tool-call` part, the step reported one tool call, `onError` never fired, and
there was no `tool-error` part. The SDK had looked at the tool call and quietly
decided not to execute it.

Tracing the execution path in `node_modules` found the gate:

```js
case "model-call-end":
  if (!isToolExecutionAllowedFinishReason(chunk.finishReason)) return;
  await Promise.all(toolCallsToExecute.map(...))
```

Tools run when the model call ends, and only if the finish reason permits it.
My mock emitted `finishReason: "tool-calls"` — a string, the shape every earlier
version of this API used. In the v4 provider spec it is an object:
`{ unified: "tool-calls", raw: "tool_use" }`. A bare string is not `"stop"` and
not `"tool-calls"`, so the check said no, the queued calls were dropped, and the
turn ended with nothing.

**Fix.** One line in the fixture. The entry is not about the fix.

**Why it is worth recording.** This is the exact failure mode the original
no-framework argument was about, arriving from the direction I had not
considered. I had worried that a framework would mediate tool _results_ and
produce an incomplete ledger. It did not. What it did instead was decline to
produce a result at all, silently, because a field three layers down had changed
shape — and the only reason that surfaced in seconds rather than in production
is that the test asserts on the _answer_, not on the plumbing. A test that
checked "a tool-call part was emitted" would have passed.

**What the test now does.** `ledger.test.ts` drives the real `ask()` with a
scripted model that calls a tool and then names a resource that tool never
returned — behaviour no prompt reliably produces, which is why it has to be
scripted. It asserts the invented ARN is flagged and the real one is not. The
model is injected through `AskOptions`, which is also the seam a DI container
will want later.

Proven by breaking it four ways: never record into the ledger, record the rows
but lose the ARNs, skip the read-only guard, and drop the tool trace. The first
two fail the assertion that a **real** ARN is accepted — which is the right
alarm, because the dangerous version of a broken ledger is not that invention
goes unflagged, it is that genuine resources get flagged and users stop reading
the warnings.

**Also worth recording: the port removed a dependency.** `@anthropic-ai/sdk` is
gone, and `TOOL_DEFINITIONS` is now typed by an interface declared in
`tools.ts` rather than borrowed from a provider's SDK. The tool boundary is the
project's most load-bearing design decision; it should not be shaped by whichever
client happens to deliver it.

**And the thing the mock cannot prove.** A stub proves the wiring, not the
provider. One live question — "how many resources, and in which regions?" —
confirmed the real path: one tool call, a correct answer, every event emitted,
and the model volunteering that the inventory was nine days old, which is the
system prompt doing its job. The twenty-one scored cases remain the end-to-end
measure and still cost money to run, so they are run deliberately rather than on
every commit.

**What to take from it.** **"It emitted the right thing" is not "it did the
right thing".** Every observable signal said the tool call happened. The only
assertion that could tell the difference was one about the user-visible outcome,
which is an argument for testing the answer rather than the mechanism — and, for
a third time in this log, for not trusting a check that cannot fail loudly.
