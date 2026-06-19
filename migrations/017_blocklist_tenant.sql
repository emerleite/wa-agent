-- wa-agent: tenant-scoping for Blocklist (v0.8).
--
-- v0.6 added tenant_id to message_queue; v0.8 mirrors that for blocked_numbers
-- so multi-tenant apps can block a number at tenant A while allowing it at
-- tenant B. Without this, the existing `whatsapp PRIMARY KEY` forces a single
-- global block list across all tenants.
--
-- Single-tenant deployments get tenant_id = '' (empty string) on every row.
-- The Blocklist class translates a missing tenantId option into '' for both
-- reads and writes so behavior is bit-for-bit compatible.
--
-- The original schema had `whatsapp` as PRIMARY KEY. SQLite doesn't let us
-- alter the primary key in-place, so we recreate the table via the standard
-- 12-step pattern: create new table → copy data → drop old → rename → recreate
-- indexes. Existing rows are preserved with tenant_id = '' (the
-- single-tenant default).

PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS blocked_numbers_new (
  whatsapp    TEXT NOT NULL,
  tenant_id   TEXT NOT NULL DEFAULT '',
  reason      TEXT NOT NULL,
  blocked_at  TEXT NOT NULL DEFAULT (datetime('now')),
  blocked_by  TEXT,
  expires_at  TEXT,
  notes       TEXT,
  PRIMARY KEY (whatsapp, tenant_id)
);

INSERT INTO blocked_numbers_new (whatsapp, tenant_id, reason, blocked_at, blocked_by, expires_at, notes)
  SELECT whatsapp, '', reason, blocked_at, blocked_by, expires_at, notes
  FROM blocked_numbers;

DROP TABLE blocked_numbers;
ALTER TABLE blocked_numbers_new RENAME TO blocked_numbers;

CREATE INDEX IF NOT EXISTS idx_blocked_expires ON blocked_numbers (expires_at);
CREATE INDEX IF NOT EXISTS idx_blocked_tenant
  ON blocked_numbers (tenant_id, expires_at);

PRAGMA foreign_keys = ON;
