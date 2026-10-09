-- The schema as it was before the ORM, kept as a test fixture.
--
-- NOT applied by anything at runtime: `drizzle/0000_*.sql` is the schema now.
-- This exists so `adoption.test.ts` can build a database in the shape a user
-- who ran an earlier version of this project actually has, and prove that
-- migrating it produces the same database as creating one from scratch.
--
-- Do not edit to match schema changes. It describes a moment in the past; a
-- change to the schema belongs in a new migration, and this file is what that
-- migration has to cope with.

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
