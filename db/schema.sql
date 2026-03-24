-- db/schema.sql
-- Target schema for M2 PostgreSQL migration.
-- Not yet executed — stub for design review and M2 planning.
--
-- Design notes:
--   - All tables carry org_id for multi-tenancy (schema-per-tenant in M2 Shared tier,
--     but org_id is present in all tiers for consistency with M1 rule #1).
--   - Composite primary keys include org_id to support schema-per-tenant migration.
--   - Field names are snake_case (PostgreSQL convention); mapping to camelCase JSON
--     model lives in db/index.js.
--   - Sensitive fields (salary, personal identifiers, band values) are annotated;
--     pgcrypto column-level encryption is applied to these in M2.
--   - audit_log is append-only: the application DB role has INSERT + SELECT only —
--     no UPDATE or DELETE. PostgreSQL triggers on all data tables write to audit_log
--     within the same transaction (hard audit guarantee introduced in M2).

-- ── Departments ───────────────────────────────────────────────────────────────

CREATE TABLE departments (
  id            TEXT        NOT NULL,
  org_id        TEXT        NOT NULL DEFAULT 'default',
  name          TEXT        NOT NULL,
  color         TEXT,
  description   TEXT,
  head_role_id  TEXT,
  PRIMARY KEY (id, org_id)
);

-- ── Teams ─────────────────────────────────────────────────────────────────────

CREATE TABLE teams (
  id            TEXT NOT NULL,
  org_id        TEXT NOT NULL DEFAULT 'default',
  name          TEXT NOT NULL,
  department_id TEXT NOT NULL,
  PRIMARY KEY (id, org_id),
  FOREIGN KEY (department_id, org_id) REFERENCES departments (id, org_id)
);

-- ── Roles ─────────────────────────────────────────────────────────────────────

CREATE TABLE roles (
  id              TEXT NOT NULL,
  org_id          TEXT NOT NULL DEFAULT 'default',
  title           TEXT NOT NULL,
  level           TEXT,               -- L1–L8
  department      TEXT,
  manager_role_id TEXT,               -- self-referential; NULL for root
  team_id         TEXT,
  PRIMARY KEY (id, org_id)
);

-- ── Persons ───────────────────────────────────────────────────────────────────

CREATE TABLE persons (
  id              TEXT    NOT NULL,
  org_id          TEXT    NOT NULL DEFAULT 'default',
  name            TEXT    NOT NULL,
  gender          TEXT,
  -- SENSITIVE: encrypt with pgcrypto in M2 (isSensitive: true in audit_log)
  salary          NUMERIC,
  employee_id     TEXT,               -- SENSITIVE
  date_of_birth   DATE,               -- SENSITIVE
  national_id     TEXT,               -- SENSITIVE
  email           TEXT,
  country         TEXT,
  city            TEXT,
  cost_center     TEXT,
  legal_entity    TEXT,
  employment_date DATE,
  PRIMARY KEY (id, org_id)
);

-- ── Role Assignments ──────────────────────────────────────────────────────────

CREATE TABLE role_assignments (
  role_id   TEXT NOT NULL,
  person_id TEXT NOT NULL,
  org_id    TEXT NOT NULL DEFAULT 'default',
  PRIMARY KEY (role_id, person_id, org_id),
  FOREIGN KEY (role_id,   org_id) REFERENCES roles   (id, org_id),
  FOREIGN KEY (person_id, org_id) REFERENCES persons  (id, org_id)
);

-- ── Salary Bands ──────────────────────────────────────────────────────────────

CREATE TABLE salary_bands (
  level     TEXT    NOT NULL,         -- L1–L8
  org_id    TEXT    NOT NULL DEFAULT 'default',
  -- SENSITIVE: encrypt with pgcrypto in M2
  min       NUMERIC,
  max       NUMERIC,
  midpoint  NUMERIC,
  currency  TEXT,
  PRIMARY KEY (level, org_id)
);

-- ── Location Multipliers ──────────────────────────────────────────────────────

CREATE TABLE location_multipliers (
  code        TEXT    NOT NULL,       -- country/region code
  org_id      TEXT    NOT NULL DEFAULT 'default',
  name        TEXT,
  multiplier  NUMERIC,
  PRIMARY KEY (code, org_id)
);

-- ── Settings ──────────────────────────────────────────────────────────────────

CREATE TABLE settings (
  org_id        TEXT    NOT NULL DEFAULT 'default',
  currency      TEXT,
  hide_salaries BOOLEAN NOT NULL DEFAULT false,  -- SENSITIVE field
  view_only     BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (org_id)
);

-- ── Audit Log ─────────────────────────────────────────────────────────────────
-- Append-only. Application role: INSERT + SELECT only (no UPDATE, no DELETE).
-- In M2: rows where is_sensitive = true have old_value/new_value encrypted
-- at column level using pgcrypto with tenant-isolated keys.
-- PostgreSQL BEFORE INSERT OR UPDATE OR DELETE triggers on all tables above
-- write to this table within the same transaction as the data change.

CREATE TABLE audit_log (
  id               UUID        NOT NULL DEFAULT gen_random_uuid(),
  org_id           TEXT        NOT NULL DEFAULT 'default',
  correlation_id   UUID,
  timestamp        TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_id         TEXT,
  actor_email      TEXT,
  actor_role       TEXT,
  actor_ip         TEXT,
  actor_user_agent TEXT,
  operation        TEXT        NOT NULL, -- CREATE | UPDATE | DELETE | BULK_SUMMARY | AI_QUERY
  entity_type      TEXT,                 -- person | role | department | team | roleAssignment | settings | salaryBand | locationMultiplier | config
  entity_id        TEXT,
  entity_label     TEXT,                 -- denormalised at write time; never joined at read time
  field            TEXT,
  old_value        JSONB,               -- encrypted at column level if is_sensitive = true (M2)
  new_value        JSONB,               -- encrypted at column level if is_sensitive = true (M2)
  change_reason    TEXT,
  source           TEXT,                -- ui | csv_import | api | system | ai
  bulk_id          UUID,
  is_sensitive     BOOLEAN     NOT NULL DEFAULT false,
  PRIMARY KEY (id)
);

-- Index for common query patterns on the audit log
CREATE INDEX audit_log_org_timestamp    ON audit_log (org_id, timestamp DESC);
CREATE INDEX audit_log_correlation      ON audit_log (correlation_id);
CREATE INDEX audit_log_entity          ON audit_log (org_id, entity_type, entity_id);
