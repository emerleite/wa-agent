-- wa-agent: leads + Meta 24h/72h customer-service-window tracker.

CREATE TABLE IF NOT EXISTS leads (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	ctwa_clid TEXT,
	whatsapp TEXT UNIQUE NOT NULL,
	ad_data TEXT NOT NULL DEFAULT '{}',
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	funnel_state TEXT NOT NULL DEFAULT 'NEW',
	opt_in INTEGER NOT NULL DEFAULT 0,
	opt_in_date TEXT,
	opt_out_date TEXT
);
CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads (created_at);
CREATE INDEX IF NOT EXISTS idx_leads_funnel_state ON leads (funnel_state);
CREATE INDEX IF NOT EXISTS idx_leads_whatsapp_opt_in ON leads (whatsapp, opt_in);

CREATE TABLE IF NOT EXISTS message_windows (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	whatsapp TEXT UNIQUE NOT NULL,
	window_type TEXT NOT NULL CHECK (window_type IN ('free', 'paid')),
	start_time TEXT NOT NULL DEFAULT (datetime('now')),
	end_time TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_message_windows_end_time ON message_windows (end_time);
