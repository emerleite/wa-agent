-- wa-agent: sequential multi-day content plans (drip campaigns, reading
-- plans, habit trackers).
--
-- plans: catalog. plan_days: per-day content. user_plans: enrollment +
-- current_day pointer. user_plan_progress: completion log (one row per
-- delivered/done day).

CREATE TABLE IF NOT EXISTS plans (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	slug TEXT UNIQUE NOT NULL,
	title TEXT NOT NULL,
	description TEXT,
	duration_days INTEGER NOT NULL,
	is_active INTEGER NOT NULL DEFAULT 1,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS plan_days (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	plan_id INTEGER NOT NULL REFERENCES plans(id),
	day INTEGER NOT NULL,
	title TEXT NOT NULL,
	content TEXT NOT NULL,
	extra_json TEXT,
	UNIQUE(plan_id, day)
);

CREATE TABLE IF NOT EXISTS user_plans (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	whatsapp TEXT NOT NULL,
	plan_id INTEGER NOT NULL REFERENCES plans(id),
	current_day INTEGER NOT NULL DEFAULT 1,
	started_at TEXT NOT NULL DEFAULT (datetime('now')),
	completed_at TEXT,
	is_active INTEGER NOT NULL DEFAULT 1,
	UNIQUE(whatsapp, plan_id)
);
CREATE INDEX IF NOT EXISTS idx_user_plans_whatsapp ON user_plans(whatsapp);
CREATE INDEX IF NOT EXISTS idx_user_plans_active ON user_plans(is_active, whatsapp);
CREATE INDEX IF NOT EXISTS idx_user_plans_plan_active ON user_plans(plan_id, is_active, completed_at);

CREATE TABLE IF NOT EXISTS user_plan_progress (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	whatsapp TEXT NOT NULL,
	plan_id INTEGER NOT NULL,
	day INTEGER NOT NULL,
	completed_at TEXT NOT NULL DEFAULT (datetime('now')),
	UNIQUE(whatsapp, plan_id, day)
);
CREATE INDEX IF NOT EXISTS idx_upp_lookup ON user_plan_progress (whatsapp, plan_id, day, completed_at);
