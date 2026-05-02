-- wa-agent: broadcast delivery audit log + re-engagement answers.
--
-- broadcast_log: one row per (user, channel, day) — used by Broadcast to skip
-- users who already got today's message on a given channel.
--
-- engagement_answers: persists yes/no answers from ReEngagement prompts so we
-- can render a weekly progress view.

CREATE TABLE IF NOT EXISTS broadcast_log (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	whatsapp TEXT NOT NULL,
	channel TEXT NOT NULL,
	date TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	UNIQUE (whatsapp, channel, date)
);
CREATE INDEX IF NOT EXISTS idx_broadcast_log_lookup ON broadcast_log (whatsapp, channel, date);

CREATE TABLE IF NOT EXISTS engagement_answers (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	engagement_id INTEGER NOT NULL,
	whatsapp TEXT NOT NULL,
	answer TEXT NOT NULL,
	date TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_engagement_answers_lookup ON engagement_answers (engagement_id, whatsapp, date);
CREATE INDEX IF NOT EXISTS idx_engagement_answers_date ON engagement_answers (date);
