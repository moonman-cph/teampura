-- db/schema.sql
-- Normalized M2 schema. All CREATE TABLE statements use IF NOT EXISTS — safe to re-run.
-- org_id is present on every table (M1 rule #1) even though only 'default' is used until M4.
-- Sensitive fields (salary, personal identifiers, band values) are annotated for M2 encryption.
-- audit_log is append-only: the application DB role has INSERT + SELECT only (no UPDATE/DELETE).

-- ── Departments ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS departments (
  id            TEXT    NOT NULL,
  org_id        TEXT    NOT NULL DEFAULT 'default',
  name          TEXT    NOT NULL,
  color         TEXT,
  description   TEXT,
  head_role_id  TEXT,
  company_wide  BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (id, org_id)
);

-- ── Teams ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS teams (
  id            TEXT NOT NULL,
  org_id        TEXT NOT NULL DEFAULT 'default',
  name          TEXT NOT NULL,
  department_id TEXT,
  PRIMARY KEY (id, org_id)
);

-- ── Roles ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS roles (
  id                         TEXT  NOT NULL,
  org_id                     TEXT  NOT NULL DEFAULT 'default',
  title                      TEXT  NOT NULL,
  level                      TEXT,
  department_id              TEXT,
  manager_role_id            TEXT,
  team_id                    TEXT,
  secondary_manager_role_ids JSONB NOT NULL DEFAULT '[]',
  PRIMARY KEY (id, org_id)
);

-- ── Persons ───────────────────────────────────────────────────────────────────
-- SENSITIVE: salary, employee_id, date_of_birth, nationality — encrypt with pgcrypto in M2

CREATE TABLE IF NOT EXISTS persons (
  id                         TEXT    NOT NULL,
  org_id                     TEXT    NOT NULL DEFAULT 'default',
  name                       TEXT    NOT NULL,
  gender                     TEXT,
  salary                     TEXT,              -- SENSITIVE (AES-256-GCM encrypted, "enc:..." prefix)
  employee_id                TEXT,              -- SENSITIVE (AES-256-GCM encrypted, "enc:..." prefix)
  email                      TEXT,
  date_of_birth              TEXT,              -- SENSITIVE
  nationality                TEXT,
  address                    TEXT,
  hire_date                  TEXT,
  contract_type              TEXT,
  pay_frequency              TEXT,
  salary_review_needed       BOOLEAN NOT NULL DEFAULT false,
  performance_review_needed  BOOLEAN NOT NULL DEFAULT false,
  extra                      JSONB   NOT NULL DEFAULT '{}', -- all other person fields
  PRIMARY KEY (id, org_id)
);

-- Add extra column if table was created before this column was introduced
ALTER TABLE persons ADD COLUMN IF NOT EXISTS extra JSONB NOT NULL DEFAULT '{}';

-- ── Role Assignments ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS role_assignments (
  id         TEXT    NOT NULL,
  org_id     TEXT    NOT NULL DEFAULT 'default',
  role_id    TEXT    NOT NULL,
  person_id  TEXT    NOT NULL,
  percentage NUMERIC,
  PRIMARY KEY (id, org_id)
);

-- ── Salary Bands ──────────────────────────────────────────────────────────────
-- SENSITIVE: min, max, midpoint — AES-256-GCM encrypted at application layer

CREATE TABLE IF NOT EXISTS salary_bands (
  level    TEXT    NOT NULL,
  org_id   TEXT    NOT NULL DEFAULT 'default',
  label    TEXT,
  min      TEXT,                                -- SENSITIVE (AES-256-GCM encrypted, "enc:..." prefix)
  max      TEXT,                                -- SENSITIVE (AES-256-GCM encrypted, "enc:..." prefix)
  midpoint TEXT,                                -- SENSITIVE (AES-256-GCM encrypted, "enc:..." prefix)
  currency TEXT,
  PRIMARY KEY (level, org_id)
);

-- ── Location Multipliers ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS location_multipliers (
  code       TEXT    NOT NULL,
  org_id     TEXT    NOT NULL DEFAULT 'default',
  name       TEXT,
  multiplier NUMERIC,
  PRIMARY KEY (code, org_id)
);

-- ── Settings ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS settings (
  org_id                   TEXT    NOT NULL DEFAULT 'default',
  currency                 TEXT,
  hide_salaries            BOOLEAN NOT NULL DEFAULT false,
  view_only                BOOLEAN NOT NULL DEFAULT false,
  hide_levels              BOOLEAN NOT NULL DEFAULT false,
  drag_drop_enabled        BOOLEAN NOT NULL DEFAULT true,
  matrix_mode              BOOLEAN NOT NULL DEFAULT false,
  use_location_multipliers BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (org_id)
);

-- ── Org Config (ancillary JSONB config: titles, levelOrder, permissionGroups, etc.) ──

CREATE TABLE IF NOT EXISTS org_config (
  org_id TEXT NOT NULL DEFAULT 'default',
  key    TEXT NOT NULL,
  value  JSONB,
  PRIMARY KEY (org_id, key)
);

-- ── Organisations ─────────────────────────────────────────────────────────────
-- Authoritative registry of all tenant org IDs.
-- status: active | suspended
-- plan_tier: trial | starter | pro | enterprise  (column exists; no enforcement until M5)
-- id and slug hold the same value — the org_id used on all other tables.

CREATE TABLE IF NOT EXISTS organisations (
  id               TEXT        NOT NULL,
  name             TEXT        NOT NULL,
  slug             TEXT        NOT NULL,
  plan_tier        TEXT        NOT NULL DEFAULT 'trial',
  status           TEXT        NOT NULL DEFAULT 'active',
  trial_expires_at TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by       TEXT,
  PRIMARY KEY (id),
  UNIQUE (slug)
);

CREATE INDEX IF NOT EXISTS organisations_status ON organisations (status);

-- ── Users ─────────────────────────────────────────────────────────────────────
-- Roles: super_admin | org_admin | hr | manager | employee
-- person_id optionally links a user account to an entry in the persons table.
-- force_logout_at: when set, any JWT issued before this timestamp is rejected.

CREATE TABLE IF NOT EXISTS users (
  id              TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  org_id          TEXT        NOT NULL DEFAULT 'default',
  email           TEXT        NOT NULL,
  password_hash   TEXT        NOT NULL,
  role            TEXT        NOT NULL DEFAULT 'employee',
  person_id       TEXT,
  status          TEXT        NOT NULL DEFAULT 'active',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login      TIMESTAMPTZ,
  last_ip         TEXT,
  force_logout_at TIMESTAMPTZ,
  PRIMARY KEY (id),
  UNIQUE (email)
);

-- Add force_logout_at to existing deployments that created the table before this column
ALTER TABLE users ADD COLUMN IF NOT EXISTS force_logout_at TIMESTAMPTZ;
-- Add last_ip to existing deployments
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_ip TEXT;

-- ── Audit Log ─────────────────────────────────────────────────────────────────
-- Append-only. Application role: INSERT + SELECT only (no UPDATE, no DELETE).

CREATE TABLE IF NOT EXISTS audit_log (
  id               UUID        NOT NULL DEFAULT gen_random_uuid(),
  org_id           TEXT        NOT NULL DEFAULT 'default',
  correlation_id   UUID,
  timestamp        TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_id         TEXT,
  actor_email      TEXT,
  actor_role       TEXT,
  actor_ip         TEXT,
  actor_user_agent TEXT,
  operation        TEXT        NOT NULL,
  entity_type      TEXT,
  entity_id        TEXT,
  entity_label     TEXT,
  field            TEXT,
  old_value        JSONB,
  new_value        JSONB,
  change_reason    TEXT,
  source           TEXT,
  bulk_id          TEXT,
  is_sensitive     BOOLEAN     NOT NULL DEFAULT false,
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS audit_log_org_ts ON audit_log (org_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS audit_log_corr   ON audit_log (correlation_id);
CREATE INDEX IF NOT EXISTS audit_log_entity ON audit_log (org_id, entity_type, entity_id);

-- ── Scheduled Jobs ────────────────────────────────────────────────────────────
-- Stores user-created jobs (planned changes, future workflow triggers, etc.).
-- status: pending | running | completed | failed | cancelled
-- job_type: PLANNED_CHANGE | DAILY_METRICS (future: NOTIFICATION, PROCESS_TRIGGER)

CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id           UUID        NOT NULL DEFAULT gen_random_uuid(),
  org_id       TEXT        NOT NULL DEFAULT 'default',
  job_type     TEXT        NOT NULL,
  label        TEXT,
  payload      JSONB       NOT NULL DEFAULT '{}',
  scheduled_at TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   TEXT,
  status       TEXT        NOT NULL DEFAULT 'pending',
  started_at   TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error        TEXT,
  PRIMARY KEY (id)
);

-- Partial index: fast lookup of due pending jobs
CREATE INDEX IF NOT EXISTS scheduled_jobs_pending
  ON scheduled_jobs (org_id, scheduled_at)
  WHERE status = 'pending';

-- ── Daily Metrics ─────────────────────────────────────────────────────────────
-- One row per org per day. Captures all org metrics as a JSONB blob so any
-- report can be built later without schema changes.
-- recorded_at is the DATE (not timestamp) the snapshot represents.

CREATE TABLE IF NOT EXISTS daily_metrics (
  id          UUID        NOT NULL DEFAULT gen_random_uuid(),
  org_id      TEXT        NOT NULL DEFAULT 'default',
  recorded_at DATE        NOT NULL,
  metrics     JSONB       NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (org_id, recorded_at)
);
