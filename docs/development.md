# Developing Sightline

Running it from source, the conventions the code follows, every command, and
what to do when something does not start. The [README](../README.md) is the
overview; this is the reference.

## Running it from source

Docker for Postgres and moto, the mock AWS; Node for the rest — hot reload, and
the CLIs to hand.

```bash
docker compose up -d          # Postgres and moto (mock AWS)
npm install

npm run seed                  # build the fictional customer account
npm run scan                  # discover it, persist it, build the graph

npm run dev:api               # http://localhost:3000
npm run dev:web               # http://localhost:5173   ← open this
```

Scans run on a Postgres-backed queue. The API process drains it itself, so this is
all you need — closing the tab no longer orphans a scan, and reloading mid-scan
rejoins it. To run scans in their own process as a hosted deployment does, set
`SCAN_WORKER=separate` and also run `npm run dev:worker`.

Both paths are covered by CI, and nothing about the product differs between them.

The browser suite drives the **hosted** product the way a customer does — sign in,
scan, read the findings, ask, start connecting an account — with GitHub and the model
stood in for on loopback. With the compose stack up and seeded:

```bash
npx playwright install chromium   # once
npm run e2e                       # starts its own API, worker and frontend
```

Run `npm run verify` before pushing — it is everything CI's static job runs.

The database-backed tests need the same stack, seeded and scanned: `npm test`
skips them without a database rather than failing.

## Configuration

The agent uses Anthropic. `ANTHROPIC_MODEL` defaults to `claude-sonnet-5`.
`/api/health` says whether a key is configured rather than making you discover it
through a failed request, and names the `.env` it read if the key is missing.

Every setting, with its default and what it is for, is in
[`.env.example`](../.env.example). `DEPLOYMENT_MODE=hosted` refuses to start on
any configuration that would make the public service silently unsafe;
[`apps/api/src/core/hostedMode.ts`](../apps/api/src/core/hostedMode.ts) is the
list, with the reason for each.

## House style

Four things, because they are the ones that have actually gone wrong here:

- **Comments carry the non-obvious _why_, and nothing else.** The bug a line
  prevents, the alternative that was rejected, the AWS behaviour that is not in the
  docs. Not a restatement of the code, not a second example, not build-up. Roughly
  ten lines is the ceiling for a genuinely subtle module header; most want two.
  `guards/commentBudget.test.ts` measures it, because this has drifted twice.
- **A guard for every agreement between two files.** If editing one file can
  silently invalidate another — a manifest and the code that reads it, a template
  and the ARN derived from it — the test goes in `guards/`. Write it so that
  _forgetting_ trips it, and break it once to watch it go red.
- **Derive, don't enumerate.** Lists in code go stale: the leak test enumerates
  queries by reflection, the purge enumerates tenant-scoped tables from the schema,
  and the graph sweep derives what to keep from the database. Each of those caught a
  real bug that a hand-written list would have missed.
- **Refuse rather than guess.** Ambiguous configuration, a mistyped id, an
  unparseable limit — fail loudly at the edge. Every silent fallback in this
  repository's history produced a working system with a quietly wrong answer.

## Every command

| Command                                        | What it does                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------ |
| `docker compose up -d`                         | Postgres and moto — just the dependencies                                      |
| `docker compose --profile app up -d --build`   | The whole thing in Docker, served on `:8080`                                   |
| `docker compose --profile app down -v`         | Tear it all down, volumes included                                             |
| `npm run setup`                                | Connect an AWS account, or switch back to the demo one                         |
| `npm run seed`                                 | Rebuild the mock account from scratch                                          |
| `npm run scan`                                 | Scan, persist, project the graph                                               |
| `npm run drift`                                | Change the mock account, so a second scan has a diff                           |
| `npm run inspect -w @sightline/api`            | Scan and print findings without touching the databases                         |
| `npm run query -w @sightline/api`              | Run every curated query against the graph                                      |
| `npm run dev:worker`                           | Run scans in their own process, as a hosted deployment does                    |
| `npm test`                                     | Unit and integration tests — integration ones skip without databases           |
| `npm run e2e`                                  | The browser suite, against the compose stack                                   |
| `npm run lint`                                 | Prettier and ESLint, both in check mode                                        |
| `npm run format`                               | Fix everything those two can fix automatically                                 |
| `npm run typecheck`                            | `tsc` over every workspace, and over `guards/` and `scripts/`                  |
| `npm run verify`                               | Everything CI's static job runs — use before pushing                           |
| `npm run evals:ground-truth -w @sightline/api` | Tier-1 evals — no API key needed                                               |
| `npm run evals -w @sightline/api`              | Tier-2 agent evals — needs a key                                               |
| `npm run gen:collectors -w @sightline/api`     | Regenerate the role template's grants and the collector list from the registry |
| `npm run openapi -w @sightline/api`            | Rewrite `docs/openapi.json`, the API description, from the contract list       |
| `npm run db:app-role -w @sightline/api`        | Set the restricted role's password, for row-level security                     |
| `./scripts/backup-restore-test.sh`             | Back up, restore, and check an ExternalId still decrypts                       |
| `helm template monitoring helm/monitoring`     | Render the monitoring stack without deploying it                               |
| `npm run db:generate -w @sightline/api`        | Generate a migration after editing `src/db/schema.ts`                          |
| `npm run db:migrate -w @sightline/api`         | Apply pending migrations — a clone also does this on boot                      |
| `npm run db:studio -w @sightline/api`          | Browse the database in Drizzle Studio                                          |

## Troubleshooting

**A `.env` edit appears to do nothing.** Configuration is read once at startup, so the
process has to be **replaced**, not restarted:

```bash
docker compose --profile app up -d api     # recreates it with the new values
```

`docker compose restart api` is the command you would reach for and it does **not**
work: it restarts the existing container, whose environment was resolved when the
container was created, so the edit is ignored and the command exits zero. On the host
path, stop `npm run dev:api` and start it again — `tsx watch` does not watch `.env`.

**A container fails to start.** Ports in use. It binds `8080` for the app and `5432`
and `5000` for Postgres and moto; each is configurable in `.env` as `APP_PORT`,
`POSTGRES_PORT` and `MOCK_AWS_PORT`.
Running two clones at once will collide.

**A scan finds nothing.** moto holds the account in memory, so any `down` empties it.
Run `npm run seed` before `npm run scan`.

**Tearing it down:**

```bash
docker compose --profile app down -v     # use this one, whichever way you started it
```

The `--profile app` flag is **required to clean up if you ever started that profile**,
and harmless if you did not. Without it, Compose removes only the default services, so
the API and nginx containers are left running against databases that no longer exist.
`-v` deletes the volumes: every scan, the graph, agent traces and recorded eval runs.

## Releasing and deploying

Every commit on `main` that passes CI is deployed: `.github/workflows/deliver.yml`
builds the API and web images, scans them, signs them, pushes them to
`ghcr.io/<owner>/sightline-api` and `-web` tagged by commit, and pins the prod
overlay to their digests in a `deploy: <sha> [skip ci]` commit. ArgoCD watches
`main`, runs the migrate Job as a PreSync hook, and rolls the pods once it has
finished. [`deploy/k8s/README.md`](../deploy/k8s/README.md) has the cluster
side.

A version tag is the other way to publish images: `git tag v0.2.0 && git push origin v0.2.0` builds the
API and web images once, fails on a critical or high vulnerability with a fix
available, and pushes them to `ghcr.io/<owner>/sightline-api` and `-web` with an SBOM,
build provenance and a keyless cosign signature. The run's summary gives each digest
and the `cosign verify` command; deploy by digest.
