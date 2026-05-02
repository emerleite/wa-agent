-- wa-agent: core message tracking
--
-- `messages` is the audit log of every inbound (and once we know the answer,
-- the response we sent). `sessions` keeps the AI thread id between turns.

CREATE TABLE IF NOT EXISTS messages (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	wamid TEXT UNIQUE,
	whatsapp TEXT,
	thread_id TEXT,
	type TEXT,
	payload TEXT,
	body TEXT,
	response TEXT,
	summary TEXT,
	feedback TEXT,
	created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
	updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_messages_whatsapp ON messages (whatsapp);
CREATE INDEX IF NOT EXISTS idx_messages_wamid ON messages (wamid);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages (created_at);

CREATE TABLE IF NOT EXISTS sessions (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	thread_id TEXT UNIQUE,
	whatsapp TEXT UNIQUE,
	created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
	updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sessions_whatsapp ON sessions (whatsapp);
CREATE INDEX IF NOT EXISTS idx_sessions_thread_id ON sessions (thread_id);
