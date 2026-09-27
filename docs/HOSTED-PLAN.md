# Hosting plan — from single-tenant demo to a real multi-tenant site

Status: **Phases 0-5 substantially built.** Branch: `feat/hosted-clean`;
`main` stays exactly as submitted. **Nothing has been deployed and no AWS
resource has been created** — the KMS key, the platform IAM user, the tunnel
and the cluster are Tom's to provision (see
[HOSTED-SETUP.md](HOSTED-SETUP.md)).

| Phase                                   | State                                                             |
| --------------------------------------- | ----------------------------------------------------------------- |
| 0 — hosted mode, capabilities removed   | **done** (ADR-015, since revised; ADR-016)                        |
| 1 — tenancy in the data layer           | **done** (ADR-017)                                                |
| 2 — per-tenant secrets and connections  | **done**, including the connection form (ADR-019)                 |
| 3 — isolation guards, job queue, worker | **done**                                                          |
| 3 — OAuth, sessions, `users` rows       | **done** (ADR-018)                                                |
| 4 — Kubernetes and Cloudflare           | **chart, worker, images and ArgoCD app written; nothing applied** |
| 5 — hardening                           | rate limits, headers, log redaction and backups **done**          |

Beyond the original plan: a demo account each tenant can switch to (ADR-020),
and observability wired into the cluster's existing Prometheus, Grafana and
Loki (ADR-021).

### What is still missing

- **Scan progress from the worker.** The streaming route reports progress
  because it runs the scan itself; a scan the worker picks up reports only when
  it finishes. Live progress needs an event bus between them.
- **Disconnect and purge.** A tenant can change their connection but not erase
  themselves. The `ON DELETE CASCADE`s are in place; the flow, and the "only
  you can delete your CloudFormation stack — here is the command" message, are
  not.
- **Turnstile on the connect form**, and Cloudflare Access in front of any
  admin surface.
- **Scheduled scans**, which is what makes change detection answer "what
  changed overnight?" without somebody remembering to press the button.

The target: a public site where someone signs in, connects their own AWS
account through the read-only role, supplies their own Anthropic key, and gets
the product that exists today — served from a home Kubernetes cluster through a
Cloudflare Tunnel, with no inbound port open anywhere.

Prior art: `~/resume_builder` already solves the hosting half of this well —
OAuth-only identity, per-user secrets encrypted with AWS KMS, SealedSecrets,
cloudflared, ArgoCD, Prometheus/Grafana/Loki. Those patterns are reused rather
than reinvented, and this document only records where **this** product needs
something different.

---

## 1. Why this is not the same problem as resume_builder

resume_builder stores a user's Anthropic API key. If one leaks, someone burns
that user's credits.

This stores **the ability to assume a role inside a real company's AWS
account**. If one leaks, or if two tenants are ever confused for one another,
the outcome is a stranger's production infrastructure read by someone who
should not see it. The blast radius is not this service — it is every account
connected to it.

Three consequences, which drive every decision below:

1. **The platform account becomes a high-value target.** It holds the identity
   that every customer's trust policy names. Compromising it is compromising
   all of them at once.
2. **A cross-tenant bug is a cross-company data breach**, not an embarrassment.
   Logical isolation therefore needs a mechanism that fails _closed_ and is
   tested, not a convention that reviewers are expected to maintain.
3. **Secrets are operational, not cosmetic.** An external id in a log line is a
   credential in a search index, because logs go to Loki.

### What we get for free

Proof of account ownership needs no verification flow. To connect, the customer
must deploy a CloudFormation stack in their own account naming our principal in
its trust policy. Only someone with write access to that account can do that —
which is stronger evidence than any email or DNS check, and it is already how
the product works.

---

## 2. Decisions taken

| #   | Decision                                                         | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Shared Neo4j, `tenantId` on every node, enforced at one seam** | Community edition has one database. Isolation is logical, so it is enforced where it cannot be forgotten and proven by a test that queries as one tenant and asserts zero rows from another.                                                                                                                                                                                                                                                    |
| 2   | **`graph_query` is disabled in hosted mode**                     | `cypherGuard.ts` and the read transaction both defend against _writes_. Neither knows whose data a read touches. In a shared graph an unfiltered `MATCH (r:Resource)` is a cross-tenant read that is not a write, so both layers pass it. A rewriter injecting a tenant predicate would be a third layer whose failure mode is silent and cross-customer. The capability is removed instead, and the Trust panel says so. Self-hosted keeps it. |
| 3   | **Branch now, merge after submission**                           | `main` stays the graded artifact: clone, `docker compose up`, it works.                                                                                                                                                                                                                                                                                                                                                                         |
| 4   | **Postgres and Neo4j in-cluster on PVCs**                        | Same shape as resume_builder's PVC-backed store. No cloud bill; backups become our responsibility and are in scope (§7).                                                                                                                                                                                                                                                                                                                        |

Decision 2 is the one to defend out loud, because it removes a feature. It is
the same argument the project already makes about mutation: the agent cannot
change anything because no tool _expresses_ a change, not because something
catches it afterwards.

---

## 3. Target architecture

```
                    Cloudflare (DNS, WAF, rate limiting, Access on /admin)
                              │  outbound-only tunnel, no inbound port
                    ┌─────────▼──────────┐
                    │  cloudflared pod   │
                    └─────────┬──────────┘
                              │  in-cluster Ingress
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
   ┌────▼────┐         ┌──────▼──────┐       ┌──────▼──────┐
   │ web     │         │ api         │       │ scan worker │
   │ (static)│         │ (Fastify)   │       │ (queue)     │
   └─────────┘         └──────┬──────┘       └──────┬──────┘
                              │                     │
                   ┌──────────┴─────────┐           │
              ┌────▼────┐        ┌──────▼─────┐     │
              │Postgres │        │  Neo4j     │◄────┘
              │ (PVC)   │        │  (PVC)     │
              └─────────┘        └────────────┘
                              │
                    ┌─────────▼──────────┐
                    │ AWS: KMS (secrets) │  ← dedicated IAM user, SealedSecret
                    │      STS AssumeRole│     two narrow policies
                    └────────────────────┘
```

The API never talks to a customer account directly on a request path. Scans run
in the worker; the API only reads what the worker persisted.

---

## 4. Tenancy

### Data model

New tables, and `tenant_id` added to every existing one:

| Table            | Purpose                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `tenants`        | One per customer. Created on first sign-in.                                                                              |
| `users`          | OAuth identity → tenant. One user per tenant initially; the column exists so teams are a later feature, not a migration. |
| `connections`    | Per tenant: role ARN, declared account id, **KMS-encrypted external id**, status, last verified.                         |
| `tenant_secrets` | Per tenant: **KMS-encrypted Anthropic key**. Separate table so it can be dropped independently of the AWS connection.    |

Every row in `scan_runs`, `scan_units`, `resource_snapshots`,
`relationship_snapshots`, `conversations`, `messages` and `eval_runs` gains
`tenant_id NOT NULL`, with it leading every index that already exists.

### The seam

All graph reads already funnel through `readQuery()` in `db/neo4j.ts`. That
becomes the enforcement point:

- signature takes a tenant context rather than bare params;
- it **refuses** — throws, not filters — any Cypher whose text does not bind
  `$tenantId`;
- the projection writes `tenantId` onto every node and relationship.

Three guards, because they fail differently:

1. **Static:** a test asserting every query string in `db/queries.ts` binds
   `$tenantId`. Catches a new query written without it.
2. **Runtime:** `readQuery` throwing on an unbound query. Catches a query built
   dynamically.
3. **Behavioural — the important one:** seed two tenants with distinguishable
   fixtures, run _every_ curated query as tenant A, assert zero rows belonging
   to B. Catches a query that binds the parameter and still leaks, which the
   other two cannot.

Guard 3 is the acceptance criterion for Phase 3. Nothing merges without it.

### Per-tenant state that is currently module-global

Two pieces of state are single-tenant by construction today and must move:

- `credentials.ts` caches one assumed session in a module-level variable, with
  one in-flight promise. Becomes a map keyed by tenant, with per-tenant
  de-duplication — the stampede protection is still needed, just per tenant.
- `routes/scans.ts` tracks `scanInProgress` as a module-level boolean, and says
  so in its own comment. Replaced by the queue (§5), with one-scan-per-tenant
  enforced by a unique partial index rather than by application logic.

---

## 5. Scans as jobs

A scan outlives an HTTP request and must survive a pod restart, so it stops
being a request handler:

- `scan_jobs` table: tenant, status, attempts, timestamps, error.
- A unique partial index on `tenant_id WHERE status IN ('queued','running')` —
  the database enforces one active scan per tenant, so a double-click cannot
  produce two.
- A worker Deployment claims jobs with `FOR UPDATE SKIP LOCKED`, runs the
  existing `runScan()` unchanged, persists, projects.
- Global concurrency cap, so one tenant's fourteen units cannot starve the
  cluster; per-tenant rate limit on how often a scan may be queued.
- A job that exceeds its timeout is marked failed with a reason, not left
  running — the product already treats a partial scan as a first-class state,
  and this is the same idea one level up.

The UI's existing progress stream reads job state instead of an in-process
emitter. No change to what the user sees.

---

## 6. Secrets

Two per tenant, both KMS-encrypted with the pattern from
`resume_builder/backend/auth.py`, neither ever returned to the browser except
where the user genuinely needs it:

| Secret                | Handling                                                                                                                                                                                                                                                                               |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **External id**       | Generated server-side, 24 bytes of CSPRNG, never user-chosen, never reused across tenants. Displayable **to its owner only** — they need it for the CloudFormation command — never logged, rotatable (rotation requires the customer to redeploy their stack, and the UI must say so). |
| **Anthropic API key** | Encrypted at rest, masked in the UI (`ak-…9f2c`), decrypted per request and never persisted in plaintext. Bring-your-own-key, so generation is billed to the user, exactly as resume_builder does it.                                                                                  |

Platform credentials: one dedicated IAM user for the pods, credentials in a
SealedSecret, with two narrow policies —

- `kms:Encrypt` / `kms:Decrypt` / `kms:DescribeKey` on the one secrets key;
- `sts:AssumeRole` restricted by resource pattern to the scanner role name the
  template creates, so a stolen credential cannot assume arbitrary roles it
  happens to find.

### Things that must be impossible

- **No endpoint override in hosted mode.** `clients.ts` supports an endpoint
  override for moto. In hosted mode it must be pinned off, unconditionally: an
  attacker-supplied endpoint would redirect signed AWS calls to a host of their
  choosing.
- **No mock mode, no runtime mode toggle.** Both exist for the demo. Hosted
  builds do not register those routes at all.
- **No secret reaches a log.** A redaction test asserting that external ids and
  API keys cannot appear in log output, run in CI.
- **Account id is pinned at connect time.** The assumed account must match what
  the connection declared, or the scan refuses — a role ARN edited later cannot
  quietly point the same connection somewhere else.

---

## 7. Kubernetes and Cloudflare

Cloned from `resume_builder/helm/resume-builder`, which already has the right
shape:

- `cloudflared` Deployment, `TUNNEL_TOKEN` from a SealedSecret via `envFrom`,
  `--no-autoupdate`, image bumps through GitOps like everything else.
- SealedSecrets for every credential; nothing plaintext is committed. `gitleaks`
  already runs in this repo's CI.
- ArgoCD Application; CI builds images on push to `main`.
- Prometheus/Grafana/Loki, alerting to Slack.

Additions specific to this product:

- **Cloudflare Access** in front of any admin surface, and **Turnstile** on the
  connect-account form, which is the expensive endpoint to abuse.
- **WAF rate limiting** at the edge in addition to per-tenant limits in the app.
- **Backups**: a CronJob dumping Postgres to object storage, encrypted, with a
  documented restore that has actually been run once. An untested backup is a
  belief, not a backup.
- **Strict CSP, HSTS**, and the session cookie `httpOnly` + `SameSite=Lax`,
  CSRF protection on state-changing routes.

---

## 8. Phases

Each is shippable and independently revertible.

| Phase | Work                                                                                                                                          | Done when                                                                       |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **0** | ADRs: multi-tenancy, secret storage, the isolation choice, the `graph_query` removal. Threat model written down.                              | Decisions recorded before code exists                                           |
| **1** | Auth and tenancy in Postgres. OAuth, sessions, `tenants`/`users`, `tenant_id` everywhere, every query filtered. **No AWS behaviour changes.** | A test proves no table carrying customer data lacks `tenant_id`                 |
| **2** | Per-tenant secrets and connections: KMS, per-tenant STS session cache, connection wizard per tenant.                                          | Two tenants hold two different connections simultaneously, proven by a test     |
| **3** | Isolation and jobs: the `readQuery` seam, three guards, `graph_query` gated off, `scan_jobs` + worker.                                        | **The cross-tenant query test passes, and fails when the predicate is removed** |
| **4** | Kubernetes: Helm chart, cloudflared, SealedSecrets, ArgoCD, CI images.                                                                        | Reachable at a hostname with no inbound port opened                             |
| **5** | Hardening: rate limits, CSP/HSTS/CSRF, Access, Turnstile, redaction test, disconnect-and-purge, backup restore drill, rotation runbook.       | A secret in a log line fails CI; a restore has been performed                   |

---

## 9. Explicitly not in scope

- Teams, roles, or sharing within a tenant. The `users` table makes it possible
  later; nothing more.
- Billing. Bring-your-own-key means there is nothing to meter.
- Anything that writes to a customer account. The read-only position is the
  product, and hosting does not change it.
- Multi-region or HA. One cluster, one replica per service, honestly documented.

## 10. Open risks

- **Logical isolation is still logical.** The guards make a leak unlikely and
  detectable, not impossible. If the product ever holds accounts that matter,
  the honest upgrade is a database per tenant, which means Enterprise or Aura.
  Recorded here so the choice is visible rather than forgotten.
- **The platform identity is the single point of catastrophic failure.** Rotation
  procedure and CloudTrail alerting on unexpected `AssumeRole` calls are part of
  Phase 5, not an afterthought.
- **Disconnect cannot revoke the trust.** Purging our side stops us scanning, but
  only the customer can delete their stack. The disconnect flow must say so and
  give them the command.
