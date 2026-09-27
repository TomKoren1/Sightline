-- Postgres is the system of record. Neo4j is a projection of what is here, and
-- can be rebuilt from these tables without going back to AWS.
--
-- Everything is append-only per scan: a scan never updates a previous scan's
-- rows. That is what makes "what changed since the last scan?" answerable, and
-- it means a bad scan can be discarded without corrupting history.

CREATE TABLE IF NOT EXISTS scan_runs (
  id                  UUID PRIMARY KEY,
  account_id          TEXT        NOT NULL,
  status              TEXT        NOT NULL CHECK (status IN ('running','succeeded','partial','failed')),
  started_at          TIMESTAMPTZ NOT NULL,
  finished_at         TIMESTAMPTZ,
  regions             TEXT[]      NOT NULL DEFAULT '{}',
  resource_count      INTEGER     NOT NULL DEFAULT 0,
  relationship_count  INTEGER     NOT NULL DEFAULT 0,
  api_calls           INTEGER     NOT NULL DEFAULT 0,
  error               TEXT
);

CREATE INDEX IF NOT EXISTS scan_runs_account_started
  ON scan_runs (account_id, started_at DESC);

-- One row per (service, region). This is the unit of partial failure, and the
-- table the UI reads to tell a user which part of their account is missing.
--
-- `region` is 'global' rather than NULL for services that are not regional, so
-- it can take part in the primary key.
CREATE TABLE IF NOT EXISTS scan_units (
  scan_id         UUID    NOT NULL REFERENCES scan_runs(id) ON DELETE CASCADE,
  service         TEXT    NOT NULL,
  region          TEXT    NOT NULL,
  status          TEXT    NOT NULL,
  resource_count  INTEGER NOT NULL DEFAULT 0,
  api_calls       INTEGER NOT NULL DEFAULT 0,
  duration_ms     INTEGER NOT NULL DEFAULT 0,
  error           TEXT,
  error_code      TEXT,
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  PRIMARY KEY (scan_id, service, region)
);

-- An immutable snapshot of every resource as of one scan.
--
-- `fingerprint` is a hash of the queryable state, so diffing two scans is an
-- index-backed join rather than a JSONB comparison across thousands of rows.
CREATE TABLE IF NOT EXISTS resource_snapshots (
  scan_id     UUID  NOT NULL REFERENCES scan_runs(id) ON DELETE CASCADE,
  arn         TEXT  NOT NULL,
  kind        TEXT  NOT NULL,
  name        TEXT  NOT NULL,
  region      TEXT,
  account_id  TEXT  NOT NULL,
  tags        JSONB NOT NULL DEFAULT '{}',
  properties  JSONB NOT NULL DEFAULT '{}',
  derived     JSONB NOT NULL DEFAULT '{}',
  fingerprint TEXT  NOT NULL,
  PRIMARY KEY (scan_id, arn)
);

CREATE INDEX IF NOT EXISTS resource_snapshots_kind ON resource_snapshots (scan_id, kind);
CREATE INDEX IF NOT EXISTS resource_snapshots_arn  ON resource_snapshots (arn);

CREATE TABLE IF NOT EXISTS relationship_snapshots (
  scan_id    UUID  NOT NULL REFERENCES scan_runs(id) ON DELETE CASCADE,
  from_arn   TEXT  NOT NULL,
  to_arn     TEXT  NOT NULL,
  rel_type   TEXT  NOT NULL,
  properties JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS relationship_snapshots_scan ON relationship_snapshots (scan_id);

-- Agent conversations. Kept in Postgres rather than the graph so that chat
-- volume never competes with the queries the agent itself runs.
CREATE TABLE IF NOT EXISTS conversations (
  id         UUID PRIMARY KEY,
  account_id TEXT        NOT NULL,
  title      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id              UUID PRIMARY KEY,
  conversation_id UUID        NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT        NOT NULL CHECK (role IN ('user','assistant')),
  content         TEXT        NOT NULL,
  -- The audit trail: which tools ran, what they returned, which ARNs the
  -- answer cited, and whether any of those citations were unsupported.
  tool_calls      JSONB       NOT NULL DEFAULT '[]',
  citations       JSONB       NOT NULL DEFAULT '[]',
  warnings        JSONB       NOT NULL DEFAULT '[]',
  scan_id         UUID        REFERENCES scan_runs(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_conversation ON messages (conversation_id, created_at);

-- Eval results, so a regression in answer quality is visible over time rather
-- than discovered in a demo.
CREATE TABLE IF NOT EXISTS eval_runs (
  id           UUID PRIMARY KEY,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  model        TEXT        NOT NULL,
  total        INTEGER     NOT NULL DEFAULT 0,
  passed       INTEGER     NOT NULL DEFAULT 0,
  mean_f1      REAL        NOT NULL DEFAULT 0,
  results      JSONB       NOT NULL DEFAULT '[]'
);

-- ---------------------------------------------------------------------------
-- Tenancy
--
-- A single-tenant deployment is one tenant that always exists, rather than a
-- special case threaded through the code. That is the whole trick: every query
-- is tenant-scoped from the first day, the demo passes the default tenant, and
-- the hosted service passes one from the session. There is no "no tenant" path
-- to forget about (ADR-017).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tenants (
  id           UUID PRIMARY KEY,
  slug         TEXT        NOT NULL UNIQUE,
  display_name TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The default tenant. Fixed id, because self-hosted code refers to it by
-- constant and a generated one would differ between machines.
INSERT INTO tenants (id, slug, display_name)
VALUES ('00000000-0000-0000-0000-000000000001', 'local', 'Local deployment')
ON CONFLICT (id) DO NOTHING;

-- OAuth identities. No passwords are stored, ever: the provider is the only
-- thing that authenticates a person here.
CREATE TABLE IF NOT EXISTS users (
  id               UUID PRIMARY KEY,
  tenant_id        UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider         TEXT        NOT NULL CHECK (provider IN ('google','github','local')),
  provider_subject TEXT        NOT NULL,
  email            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at     TIMESTAMPTZ,
  UNIQUE (provider, provider_subject)
);

CREATE INDEX IF NOT EXISTS users_tenant ON users (tenant_id);

-- One AWS connection per tenant.
--
-- `external_id_encrypted` is a secret of the same class as an API key: it is
-- half of what authorises an AssumeRole into a customer's account, so it is
-- KMS-encrypted at rest and never logged. `account_id` is pinned when the
-- connection is verified, so a role ARN edited later cannot quietly repoint an
-- existing connection at a different account.
CREATE TABLE IF NOT EXISTS connections (
  tenant_id             UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  role_arn              TEXT        NOT NULL,
  account_id            TEXT,
  external_id_encrypted BYTEA       NOT NULL,
  status                TEXT        NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','verified','failed','disconnected')),
  last_verified_at      TIMESTAMPTZ,
  last_error            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Bring-your-own-key, so generation is billed to the tenant's own account.
-- Separate table from `connections` so a tenant can drop one without the other.
CREATE TABLE IF NOT EXISTS tenant_secrets (
  tenant_id               UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  anthropic_key_encrypted BYTEA,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Scans as queued work rather than as an HTTP request.
--
-- A scan outlives the request that asked for it and must survive a pod
-- restart. The partial unique index below is the point: one active scan per
-- tenant is enforced by the database, so a double-click cannot produce two -
-- which is what the module-level boolean it replaces could not promise.
CREATE TABLE IF NOT EXISTS scan_jobs (
  id          UUID PRIMARY KEY,
  tenant_id   UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  status      TEXT        NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  scan_id     UUID        REFERENCES scan_runs(id) ON DELETE SET NULL,
  attempts    INTEGER     NOT NULL DEFAULT 0,
  queued_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at  TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  claimed_by  TEXT,
  error       TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS scan_jobs_one_active_per_tenant
  ON scan_jobs (tenant_id) WHERE status IN ('queued','running');

CREATE INDEX IF NOT EXISTS scan_jobs_claimable ON scan_jobs (status, queued_at);

-- ---------------------------------------------------------------------------
-- tenant_id on everything that holds customer data
--
-- Added, backfilled to the default tenant, then made NOT NULL **with no
-- default**. The missing default is deliberate: an insert that forgets the
-- tenant fails loudly rather than landing in whichever tenant the default
-- names, which in a shared database is somebody else's data.
-- ---------------------------------------------------------------------------

ALTER TABLE scan_runs ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE;
UPDATE scan_runs SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
ALTER TABLE scan_runs ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE scan_runs ALTER COLUMN tenant_id DROP DEFAULT;
CREATE INDEX IF NOT EXISTS scan_runs_tenant ON scan_runs (tenant_id);

ALTER TABLE scan_units ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE;
UPDATE scan_units SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
ALTER TABLE scan_units ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE scan_units ALTER COLUMN tenant_id DROP DEFAULT;
CREATE INDEX IF NOT EXISTS scan_units_tenant ON scan_units (tenant_id);

ALTER TABLE resource_snapshots ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE;
UPDATE resource_snapshots SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
ALTER TABLE resource_snapshots ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE resource_snapshots ALTER COLUMN tenant_id DROP DEFAULT;
CREATE INDEX IF NOT EXISTS resource_snapshots_tenant ON resource_snapshots (tenant_id);

ALTER TABLE relationship_snapshots ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE;
UPDATE relationship_snapshots SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
ALTER TABLE relationship_snapshots ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE relationship_snapshots ALTER COLUMN tenant_id DROP DEFAULT;
CREATE INDEX IF NOT EXISTS relationship_snapshots_tenant ON relationship_snapshots (tenant_id);

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE;
UPDATE conversations SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
ALTER TABLE conversations ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE conversations ALTER COLUMN tenant_id DROP DEFAULT;
CREATE INDEX IF NOT EXISTS conversations_tenant ON conversations (tenant_id);

ALTER TABLE messages ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE;
UPDATE messages SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
ALTER TABLE messages ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE messages ALTER COLUMN tenant_id DROP DEFAULT;
CREATE INDEX IF NOT EXISTS messages_tenant ON messages (tenant_id);

ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE;
UPDATE eval_runs SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
ALTER TABLE eval_runs ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE eval_runs ALTER COLUMN tenant_id DROP DEFAULT;
CREATE INDEX IF NOT EXISTS eval_runs_tenant ON eval_runs (tenant_id);

-- A tenant can point at the demo account instead of their own.
--
-- Per tenant, not per process: the single-tenant toggle it replaces was a
-- module-level flag, which with several tenants on one process means one
-- person's click changes what everybody else is looking at (ADR-020).
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS demo_mode BOOLEAN NOT NULL DEFAULT false;

-- The external id belongs to the tenant, not to the connection.
--
-- It was a column on `connections`, which meant it could not exist until a
-- role ARN did - so the Connection panel generated a fresh one on every page
-- load to show the customer. They would paste that into their CloudFormation
-- stack, save the role, and the server would generate a *different* one to
-- store: AccessDenied, with nothing in the message to suggest why.
--
-- It is also the right model. An external id identifies this customer to AWS;
-- it does not depend on which role they happen to point at, and AWS's own
-- guidance is one per customer.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS external_id_encrypted BYTEA;

-- Carry over anything already issued, then stop using the old column.
UPDATE tenants t
   SET external_id_encrypted = c.external_id_encrypted
  FROM connections c
 WHERE c.tenant_id = t.id AND t.external_id_encrypted IS NULL;

ALTER TABLE connections ALTER COLUMN external_id_encrypted DROP NOT NULL;
