-- wa-agent: per-user, per-feature usage log for daily caps + analytics.
--
-- Backs `UsageCounter`. One row per feature use; queries aggregate by date.

CREATE TABLE IF NOT EXISTS feature_usage (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	whatsapp TEXT NOT NULL,
	feature TEXT NOT NULL,
	key TEXT,
	used_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_feature_usage_user ON feature_usage(whatsapp, feature, used_at DESC);
CREATE INDEX IF NOT EXISTS idx_feature_usage_feature ON feature_usage(feature, used_at DESC);
