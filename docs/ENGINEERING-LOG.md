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

**Fix.** Implemented as an _optional fast path_: the scanner calls
`ListIndexes`, and only if an aggregator index exists does it use `Search` for
bulk discovery. Otherwise it falls back to per-service enumeration. The
fallback is the path that is tested and demonstrated; the fast path is written,
guarded, and documented as unverified against a real account.

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
