-- wa-agent: D1-backed message-coalescing queue.
--
-- A message is enqueued on receipt; a per-user debounce window (default 3s)
-- holds rapid-fire bursts together. processAll() claims a per-user batch and
-- the agent calls one combined LLM turn for the whole burst.

CREATE TABLE IF NOT EXISTS message_queue (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	message_id TEXT UNIQUE,
	whatsapp TEXT NOT NULL,
	payload TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'pending',
	attempts INTEGER NOT NULL DEFAULT 0,
	scheduled_at TEXT NOT NULL DEFAULT (datetime('now', '+3 seconds')),
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	started_at TEXT,
	completed_at TEXT,
	error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_mq_pending_scheduled ON message_queue (status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_mq_whatsapp_pending ON message_queue (whatsapp, status);
CREATE INDEX IF NOT EXISTS idx_mq_claim ON message_queue (whatsapp, status, started_at);
