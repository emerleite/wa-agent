-- wa-agent: slot-based content delivery (ads, tips, daily picks).

CREATE TABLE IF NOT EXISTS ads (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	slug TEXT UNIQUE NOT NULL,
	title TEXT NOT NULL,
	body TEXT NOT NULL,
	cta_text TEXT,
	cta_url TEXT,
	video_url TEXT,
	weight INTEGER NOT NULL DEFAULT 1,
	is_active INTEGER NOT NULL DEFAULT 1,
	starts_at TEXT,
	ends_at TEXT,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ads_active ON ads(is_active);

CREATE TABLE IF NOT EXISTS ad_impressions (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	whatsapp TEXT NOT NULL,
	item_id INTEGER NOT NULL,
	slot TEXT,
	sent_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ad_impressions_user ON ad_impressions(whatsapp, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_ad_impressions_slot ON ad_impressions(slot, sent_at);
