-- App-specific table for the tool-agent example. The framework's own
-- migrations (0000..023) go in first via `--migrations-dir ../../migrations`.

CREATE TABLE IF NOT EXISTS appointments (
  id         TEXT PRIMARY KEY,
  whatsapp   TEXT NOT NULL,
  day        TEXT NOT NULL,
  time       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_appointments_user ON appointments (whatsapp, day, time);
