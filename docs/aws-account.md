# Connecting a real AWS account

Entirely optional — the mock exercises the same code paths, and the scanner does not
know it is talking to a mock. `npm run setup` does the whole thing: it shows what it
will do and asks before anything changes, backs `.env` up first, and rewrites **only**
the keys it names — verified against its own output rather than promised. It never
asks for an access key and cannot write one. Re-running is a no-op, and it reuses an
ExternalId already in use rather than rotating a working secret.

|                                   |                                                 |
| --------------------------------- | ----------------------------------------------- |
| `npm run setup -- --dry-run`      | print the plan, change nothing                  |
| `npm run setup -- --mock`         | stay on the demo account                        |
| `npm run setup -- --disconnect`   | delete the role and go back to the demo account |
| `npm run setup -- --profile work` | use a named AWS CLI profile                     |
| `npm run setup -- --yes`          | no confirmations, for scripting                 |

**Several accounts** are connected one at a time, in the hosted product, from
**Connect another account…** in the account switcher. Each is scanned, pinned and
isolated on its own. The connect screen no longer offers a whole AWS Organization:
the API still supports it, and organizations connected before keep working, but
new connections are single accounts. Paths _between_ accounts are not modelled yet.

It needs the AWS CLI, which is also what creates the role. The demo account needs
neither it nor Node.

The **account switcher** in the header opens the same walkthrough by hand from
**Connect another account…**, and moves between accounts at runtime without restarting or
rewriting `.env` — a clone has two, the demo fixture and whatever `.env` points at.
Switching does not rescan: each account shows its own latest scan, and the banner says
how old it is, or that the account has no scan yet. One account's inventory never
appears under another's name.

It replaced a demo/real toggle that flipped a module-level variable. That was honest for
one operator and would have been a shared surprise for many: one person clicking it
would have changed which AWS account every other tenant on the process was looking at.
The switcher sends a header instead, and the server validates that the connection is
yours.

By hand: deploy [`cloudformation/readonly-role.yaml`](../cloudformation/readonly-role.yaml) and set

```bash
AWS_MODE=real                 # drops the endpoint override
AWS_TARGET_ROLE_ARN=arn:aws:iam::<customer>:role/SightlineReadOnlyRole
AWS_EXTERNAL_ID=<the per-customer secret>
AWS_SCAN_REGIONS=             # empty = discover every enabled region
```

In `real` mode the source credentials come from the standard AWS chain. Assume-role,
pagination, adaptive retry, region fan-out and partial-failure handling are the same
code in both modes.

## Three things that are easy to get wrong

Each of these cost a real deployment.

- **Two ARNs are involved and each looks like a valid value for the other.**
  `SightlineScannerRoleArn` is an _input_ — the principal allowed to assume.
  `AWS_TARGET_ROLE_ARN` is the stack's `RoleArn` _output_ — the role that gets
  assumed. `sts:AssumeRole` can only assume a role, so a user ARN in the second can
  never work; the API refuses it by name at startup rather than failing later with
  `AccessDenied`.
- **`aws sts get-caller-identity` does not print a principal ARN.** It reports your
  _session_, so it returns `arn:aws:sts::…`. A trust policy needs the
  `arn:aws:iam::…` identity behind it. The guide converts it; pasting the raw value
  fails the template's own parameter pattern.
- **The role must be deployed from the current template.** Every `AssumeRole` sends
  `sts:SourceIdentity` and the trust policy requires it. A role deployed from an
  older copy matches a pattern no legal value can satisfy — AWS forbids a colon in a
  SourceIdentity — so the assume is refused with `AccessDenied`.

## Getting credentials into the container

The scanner uses the standard AWS credential chain, which finds `~/.aws` on a host. A
container has no such directory unless it is given one, so a profile that works
locally fails inside the container with _"No source credentials were found"_.
Uncomment these in `.env`:

```bash
COMPOSE_PATH_SEPARATOR=:
COMPOSE_FILE=docker-compose.yml:deploy/compose.aws-profile.yml
```

The separator line is for Windows, where Compose splits `COMPOSE_FILE` on `;` and
otherwise fails with _"The filename, directory name, or volume label syntax is
incorrect"_. It is harmless elsewhere.

That mounts `~/.aws` read-only, and — the reason it belongs in `.env` rather than as
`-f` flags on the command line — it applies to **every** subsequent
`docker compose` command automatically. With flags, recreating the API to pick up an
edited `.env` drops the mount without saying so, and the next connection test reports
missing credentials for a setup that was working a moment earlier.

**On Windows there is nothing more to set.** PowerShell does not set `HOME`, so the
mount falls back to `USERPROFILE`; Git Bash and WSL set `HOME`. Avoid putting a
`C:/...` path in `AWS_PROFILE_DIR` if you ever run Compose from WSL — the Linux CLI
cannot parse it and the API fails to start with _"invalid volume specification"_.

It lands at `/home/node/.aws`, because the API container runs as the non-root `node`
user and that is where the SDK resolves `~` to. If the connection test still reports
missing credentials with those two lines already set, the mount is arriving somewhere
else — the message names the path it actually read, and
`docker exec sightline-api ls -l ~/.aws` confirms it.

The profile goes into **both** the API and the worker, and that matters more than it
looks. With `SCAN_WORKER=separate` — which the `app` profile sets — the API only
enqueues work and the worker is the process that calls `sts:AssumeRole`. Giving the
profile to the API alone produces the most misleading failure in this setup: the
connection test passes, and every scan fails with _"Could not load credentials from
any providers"_, which reads as a broken role rather than a missing mount. For the
same reason, recreate both after editing `.env`:

```bash
docker compose --profile app up -d api worker
```

A passing connection test is not proof that scans can authenticate. The test runs in
the API; the scan runs in the worker. `docker compose exec -T worker ls /home/node/.aws`
is the direct check, and the worker's log is where a credentials failure appears.

The mount is preferable to real keys in `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`:
it keeps long-lived credentials out of a file sitting next to the code, and it carries
the SSO token cache, so `aws sso login` on the host works inside the container too.

## A second account

The account `.env` names is the deployment's own: `npm run setup` writes it, and
running setup again against a different account **replaces** it rather than adding one.

To add an account alongside it, use **Connect another account…** in the account menu.
That form names the connection, shows the `aws cloudformation deploy` command to run
with a CLI profile for the account being added, and then asks for the account id and
tests the role. Each connection carries its own ExternalId and role, and the account
menu switches between them.

A connection created this way stores its ExternalId encrypted, so `.env` needs a key.
`npm run setup` generates `SECRETS_LOCAL_KEY` when it configures a real account, so
there is normally nothing to do — and it never replaces an existing one.

**Back that key up along with `.env`.** Every ExternalId stored through the form is
encrypted under it, so losing it means reconnecting those accounts. The account `.env`
names is unaffected: its ExternalId is in `.env` in plain sight, which is why encrypting
a copy of it would protect nothing.

If the key is missing — an install that only ever ran the demo, say — the form says so
and names the variable rather than failing obscurely. Add it, then
`docker compose --profile app up -d api worker`.

There is no quick-create link or Terraform snippet here, only the CLI command: those are
built from a _published_ template URL, and a clone has the template in its own checkout
instead.

## In the hosted product

**Connecting an account** is one link and one field. A quick-create CloudFormation link
arrives with the ExternalId and the trusted principal already filled in, the customer
ticks the IAM acknowledgement and presses Create stack, and types their twelve-digit
account id — the role's name is fixed by the template, so Sightline derives the ARN
rather than asking anyone to paste one. The screen then polls `sts:AssumeRole` and goes
green on its own, usually while they are still looking at CloudFormation.

Two things it deliberately does not do. The stack creates **one IAM role and calls
nobody**: a Lambda-backed custom resource could report the ARN back and remove the twelve
digits entirely, and that would put a function, an execution role and an outbound call to
a third party into a stack a security reviewer has to approve. And the ExternalId stays
**readable** to whoever owns the connection rather than being shown once — it grants
nothing without Sightline's own credentials, their deployed stack holds it in plaintext in
the trust policy anyway, and hiding it makes a failed deploy unrecoverable without
rotating a secret the stack already contains. The AWS CLI and Terraform forms sit behind
the same link, because a console link is useless to anyone whose organisation forbids it.

When it does not work, the diagnosis is the product. `AccessDenied` becomes "the trust
policy does not name this principal — it names _this_ one, redeploy with that value, and
here is the command to check", which is the difference between ten minutes and an
afternoon.
