-- wa-agent v0.9.1: cross-category pacing ledger for bot-initiated sends.
--
-- "Bot-initiated" here means cron-triggered or otherwise NOT in response to
-- an inbound user message (devotional, plan day, engagement nudge, salvage
-- window-close touch, opportunistic ad). Reactive sends inside an active
-- conversation aren't paced — they're already gated by the user's turn.
--
-- The primitive enforces two gates per (whatsapp, today):
--   1. Minimum gap between any two sends (e.g. ≥60 min) — prevents bunching
--      when multiple cron handlers all fire on the same minute.
--   2. Per-category daily cap (e.g. ads ≤3/day) — keeps category-specific
--      ceilings without scattered if-statements in handlers.
--
-- Both are SQL queries against this table (no leads column required).
-- Apps that already have their own pacing column on a users/leads table can
-- keep using it; this is a self-contained alternative.
--
-- Apps with their own richer schema (extra columns, FKs to a tenant
-- registry, etc.) point BotSendPacing at their table via `tableName` +
-- `columnMap` + `omitColumns` + `allowedExtraColumns` — same pattern as
-- EscalationStore / ConsentStore / AgentReviewQueue / AICallLedger.
--
-- Columns:
--   id         — autoincrement primary key.
--   whatsapp   — E.164 of the recipient.
--   category   — caller-defined label (e.g. 'devotional', 'plan',
--                'engagement', 'salvage', 'ad').
--   tenant_id  — multi-tenant scoping; single-tenant apps leave NULL.
--   sent_at    — exact timestamp; used by the min-gap predicate.
--   date       — date in UTC; used by the daily-cap predicate. Cheaper to
--                index + filter on than `date(sent_at)`.

CREATE TABLE IF NOT EXISTS bot_send_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  whatsapp  TEXT NOT NULL,
  category  TEXT NOT NULL,
  tenant_id TEXT,
  sent_at   TEXT NOT NULL DEFAULT (datetime('now')),
  date      TEXT NOT NULL DEFAULT (date('now'))
);

-- For the daily-cap query: COUNT(*) WHERE whatsapp=? AND date=date('now') [AND category=?]
CREATE INDEX IF NOT EXISTS idx_bot_send_log_whatsapp_date
  ON bot_send_log (whatsapp, date);

-- For the min-gap query: EXISTS WHERE whatsapp=? AND sent_at > datetime('now', '-X minutes')
CREATE INDEX IF NOT EXISTS idx_bot_send_log_whatsapp_sent_at
  ON bot_send_log (whatsapp, sent_at);

-- For per-tenant analytics dashboards.
CREATE INDEX IF NOT EXISTS idx_bot_send_log_tenant_date
  ON bot_send_log (tenant_id, date);
