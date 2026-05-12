-- wa-agent: per-WhatsApp-number abuse blocklist.
--
-- Replaces hardcoded `if (payload.whatsapp == 'X') return` checks in
-- webhook handlers. New numbers can be blocked at runtime — no deploy
-- required.
--
-- whatsapp     — E.164 number, primary key (one row per number).
-- reason       — short tag for ops triage ('spam' | 'abuse' | 'test' | …);
--                free-form text, but keep it terse for grouped queries.
-- blocked_at   — when the row was inserted (defaults to now).
-- blocked_by   — admin identifier (free-form: email, name, "auto:rate-limit").
-- expires_at   — nullable; NULL means permanent. Used by isBlocked() to
--                gate active vs expired rows without a separate cleanup job.
-- notes        — free-form context for future humans triaging the entry.

CREATE TABLE IF NOT EXISTS blocked_numbers (
  whatsapp    TEXT PRIMARY KEY,
  reason      TEXT NOT NULL,
  blocked_at  TEXT NOT NULL DEFAULT (datetime('now')),
  blocked_by  TEXT,
  expires_at  TEXT,
  notes       TEXT
);

CREATE INDEX IF NOT EXISTS idx_blocked_expires ON blocked_numbers (expires_at);
