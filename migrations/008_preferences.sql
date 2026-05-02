-- wa-agent: per-user, per-key preferences.
--
-- One row per (whatsapp, key). Adding a new preference type takes zero
-- migrations — just call set() with a new key.
--
-- Backs `PreferenceStore`.

CREATE TABLE IF NOT EXISTS user_preferences (
	whatsapp TEXT NOT NULL,
	key TEXT NOT NULL,
	value TEXT NOT NULL,
	updated_at TEXT NOT NULL DEFAULT (datetime('now')),
	PRIMARY KEY (whatsapp, key)
);

CREATE INDEX IF NOT EXISTS idx_user_preferences_key ON user_preferences (key);
