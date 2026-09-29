# Setup, configuration and troubleshooting

Everything the [README](../README.md) deliberately leaves out. You should not need
any of this to run the project or to connect an AWS account — `npm run setup` does
that — but it is here when something does not behave.

- [Working on the code](#working-on-the-code)
- [The agent's LLM key](#the-agents-llm-key)
- [Connecting a real AWS account by hand](#connecting-a-real-aws-account-by-hand)
- [Troubleshooting](#troubleshooting)
- [Every command](#every-command)

---

## Working on the code

Docker for the three dependencies, Node for the rest — hot reload, and the CLIs to
hand. This is what I develop against.

```bash
docker compose up -d          # Postgres, Neo4j, and moto (mock AWS)
npm install

npm run seed                  # build the fictional customer account
npm run scan                  # discover it, persist it, build the graph

npm run dev:api               # http://localhost:3000
npm run dev:web               # http://localhost:5173   ← open this
```

Both paths are covered by CI, and nothing about the product differs between them.

## The agent's LLM key

The agent uses Anthropic. Put a key in `.env`:

```bash
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-5   # default
```

Everything except chat works without one — the scan, the graph, the findings
sidebar, and the entire tier-1 eval suite. `/api/health` says whether a key is
configured rather than making you discover it through a failed request, and names
the `.env` it read if the key is missing.

`npm run setup -- --anthropic-key sk-ant-...` will write it for you.

## Connecting a real AWS account by hand

Entirely optional — the mock account exercises the same code paths, and the scanner
does not know it is talking to a mock. `npm run setup` is introduced
[in the README](../README.md#start-it); this is what it does and how to steer it.

It shows what it will do and asks before anything changes, backs `.env` up first,
and rewrites **only** the keys it names — verified against its own output rather
than promised. It never asks for an access key and cannot write one. Re-running is
a no-op, and it reuses an ExternalId already in use rather than rotating a working
secret.

|                                   |                                                 |
| --------------------------------- | ----------------------------------------------- |
| `npm run setup -- --dry-run`      | print the plan, change nothing                  |
| `npm run setup -- --mock`         | stay on the demo account                        |
| `npm run setup -- --disconnect`   | delete the role and go back to the demo account |
| `npm run setup -- --profile work` | use a named AWS CLI profile                     |
| `npm run setup -- --yes`          | no confirmations, for scripting                 |

It needs the AWS CLI, which is also what creates the role. The demo account needs
neither it nor Node.

The UI's **Connection** panel walks through the same thing by hand, and the
**Demo / My AWS** toggle in the header switches between accounts at runtime without
restarting or rewriting `.env`. Switching does not rescan, so the graph keeps
showing the previous account until you run one — the banner says so rather than
letting you read one account's inventory under another's name.

Deploy [`infra/readonly-role.yaml`](../infra/readonly-role.yaml) and set:

```bash
AWS_MODE=real                 # drops the endpoint override
AWS_TARGET_ROLE_ARN=arn:aws:iam::<customer>:role/DaveIoReadOnlyRole
AWS_EXTERNAL_ID=<the per-customer secret>
AWS_SCAN_REGIONS=             # empty = discover every enabled region
```

In `real` mode the source credentials come from the standard AWS chain
(environment, shared config, container or instance role). Assume-role, pagination,
adaptive retry, region fan-out and partial-failure handling are the same code in
both modes. `AWS_SCAN_REGIONS=` blank means "discover every enabled region", and is
one of only two variables where blank is meaningful rather than unset.

**Three things are easy to get wrong here, and each cost a real deployment**
(engineering logs #28, #46):

- **Two ARNs are involved and each looks like a valid value for the other.**
  `DaveIoScannerRoleArn` is an _input_ — the principal allowed to assume.
  `AWS_TARGET_ROLE_ARN` is the stack's `RoleArn` _output_ — the role that gets
  assumed. `sts:AssumeRole` can only assume a role, so a user ARN in the second can
  never work; the API refuses it by name at startup rather than failing later with
  `AccessDenied`.
- **`aws sts get-caller-identity` does not print a principal ARN.** It reports your
  _session_, so it returns `arn:aws:sts::…`. A trust policy needs the
  `arn:aws:iam::…` identity behind it. The guide converts it; pasting the raw value
  fails the template's own parameter pattern.
- **The trust policy must name the identity the backend actually runs as**, which is
  not necessarily the one you had in mind when you deployed. When AssumeRole is
  refused, the connection test prints the principal it is authenticating as and the
  command to show what the policy names.

**The credentials have to reach the container.** The scanner uses the standard AWS
credential chain, which finds `~/.aws` on a host. A container has no such directory
unless it is given one, so a profile that works locally fails inside the container
with _"No source credentials were found"_. Uncomment these in `.env`:

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
edited `.env` drops the mount without saying so, and the next connection test
reports missing credentials for a setup that was working a moment earlier.

**On Windows there is nothing more to set.** PowerShell does not set `HOME`, so the
mount falls back to `USERPROFILE`; Git Bash and WSL set `HOME`. Avoid putting a
`C:/...` path in `AWS_PROFILE_DIR` if you ever run Compose from WSL — the Linux CLI
cannot parse it and the API fails to start with _"invalid volume specification"_.

The mount is preferable to putting real keys in `AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY`: it keeps long-lived credentials out of a file sitting next
to the code, and it carries the SSO token cache, so `aws sso login` on the host
works inside the container too.

It is a separate compose file rather than a volume in `docker-compose.yml` because
the path must come from `${HOME}`, which is not set on every platform Compose runs
on — and an unset variable in a volume spec breaks the whole file, including the
mock path that has nothing to do with real AWS.

**The role must be deployed from the current template.** Every `AssumeRole` sends
`sts:SourceIdentity` and the trust policy requires it. A role deployed from an
**older** copy of the template matches a pattern no legal value can satisfy — AWS
forbids a colon in a SourceIdentity — so the assume is refused with `AccessDenied`.
Redeploy from the current template; the connection test names this as one of the
three causes it checks.

## Troubleshooting

**A `.env` edit appears to do nothing.** Configuration is read once at startup, so
the process has to be **replaced**, not restarted:

```bash
docker compose --profile app up -d api     # recreates it with the new values
```

`docker compose restart api` is the command you would reach for and it does **not**
work: it restarts the existing container, whose environment was resolved when the
container was created, so the edit is ignored and the command exits zero. On the
host path, stop `npm run dev:api` and start it again — `tsx watch` does not watch
`.env`.

**A container fails to start.** Ports in use. It binds `8080` for the app and
`5432`, `7474`, `7687`, `5000` for Postgres, Neo4j and moto; each is configurable in
`.env` as `APP_PORT`, `POSTGRES_PORT`, `NEO4J_HTTP_PORT`, `NEO4J_BOLT_PORT` and
`MOCK_AWS_PORT`. Running two clones at once will collide.

**Tearing it down:**

```bash
docker compose --profile app down -v     # use this one, whichever way you started it
```

The `--profile app` flag is **required to clean up if you ever started that
profile**, and harmless if you did not. Without it, Compose removes only the
services in the default configuration, so the API and nginx containers are left
running against databases that no longer exist and the network cannot be removed.
That is a Compose behaviour rather than a choice here — `--remove-orphans` does not
cover profiled services either.

`-v` deletes the volumes: every scan, the graph, agent traces and recorded eval
runs. And **any** `down` empties the mock AWS account, because moto holds it in
memory — so afterwards run `npm run seed` before `npm run scan`, or the scan
discovers an empty account.

**If you edit the compose file**, two things to know. Every connection default in
`config.ts` is `localhost`, which is right on a laptop and wrong inside a container,
so the container hostnames are set in the compose service's `environment:` block —
which takes precedence over `env_file` — rather than in a second `.env` that would
eventually disagree with the first. And nginx proxies `/api` with
`proxy_buffering off`, because scans and agent answers are server-sent event
streams: a buffering proxy delivers them all at the end, which is the same problem
the Vite dev server solves in development.

## Every command

| Command                                      | What it does                                           |
| -------------------------------------------- | ------------------------------------------------------ |
| `docker compose up -d`                       | Postgres, Neo4j and moto — just the dependencies       |
| `docker compose --profile app up -d --build` | The whole thing in Docker, served on `:8080`           |
| `docker compose --profile app down -v`       | Tear it all down, volumes included                     |
| `npm run setup`                              | Connect an AWS account, or switch back to the demo one |
| `npm run seed`                               | Rebuild the mock account from scratch                  |
| `npm run scan`                               | Scan, persist, project the graph                       |
| `npm run drift`                              | Change the mock account, so a second scan has a diff   |
| `npm run inspect -w @daveio/api`             | Scan and print findings without touching the databases |
| `npm run query -w @daveio/api`               | Run every curated query against the graph              |
| `npm test`                                   | 393 unit tests                                         |
| `npm run verify`                             | Everything CI's static job runs — use before pushing   |
| `npm run evals:ground-truth -w @daveio/api`  | Tier-1 evals — no API key needed                       |
| `npm run evals -w @daveio/api`               | Tier-2 agent evals — needs a key                       |

---
