-- wa-agent: per-user consent tracking.
--
-- Apps that need a "has the user opted into AI processing / data retention /
-- marketing messages" gate get an opinionated default schema. Apps with
-- their own richer table (patient FKs, multi-tenant scoping, evidence
-- column, audit log of grant/revoke pairs) point `ConsentStore` at it via
-- `tableName` + `columnMap` — same flex pattern as `EscalationStore`.
--
-- Columns:
--   whatsapp   — E.164 of the user who granted the consent.
--   type       — short identifier ('ai_processing', 'data_retention',
--                'marketing'); free-form, but stable per app.
--   granted_at — when the consent was created. Driven by INSERT default.
--   revoked_at — NULL until the user opts out. `has()` treats non-null as
--                "consent withdrawn".
--   tenant_id  — optional. Multi-tenant apps scope by it; single-tenant
--                apps leave it NULL.
--   evidence   — free-form proof string: the wamid that captured the
--                opt-in button tap, an external workflow id, etc.

-- Note: the natural primary key is `(whatsapp, type, tenant_id)` — but SQLite
-- doesn't accept expressions inside PRIMARY KEY constraints and `tenant_id`
-- is nullable. We use a unique INDEX with `COALESCE(tenant_id, '')` instead,
-- which gives the same semantics: one consent row per (user, type, tenant).
CREATE TABLE IF NOT EXISTS user_consents (
	whatsapp    TEXT NOT NULL,
	type        TEXT NOT NULL,
	granted_at  TEXT NOT NULL DEFAULT (datetime('now')),
	revoked_at  TEXT,
	tenant_id   TEXT,
	evidence    TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_consents_pk
	ON user_consents (whatsapp, type, COALESCE(tenant_id, ''));
CREATE INDEX IF NOT EXISTS idx_user_consents_type ON user_consents (type, revoked_at);
CREATE INDEX IF NOT EXISTS idx_user_consents_tenant ON user_consents (tenant_id, type);
