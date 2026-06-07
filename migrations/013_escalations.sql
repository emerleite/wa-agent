-- wa-agent: structured escalation log — "send this turn to a human".
--
-- Why this exists: `PolicyGate` produces `action: 'escalate'` decisions
-- (crisis keywords, ambiguous intents, tool failures, cost-limit hits),
-- but the framework had no place to record them or anyone to notify.
-- Each row captures what triggered the escalation and stays open until an
-- operator acknowledges by calling `resolve(id)`.
--
-- Columns:
--   whatsapp     — E.164 of the user whose turn was escalated.
--   reason       — short tag for operator triage ('crisis' | 'ambiguous'
--                  | 'policy_violation' | 'patient_requested' |
--                  'tool_failed' | 'cost_limit'); free-form text, but keep
--                  it stable for grouped queries.
--   urgency      — 'low' | 'medium' | 'high' | 'critical'. Drives notifier
--                  routing (high+critical typically push immediately).
--   message      — human-readable summary (the user's text, the policy
--                  predicate's `reason`, etc.).
--   trace_id     — correlate with the pipeline's `agent_decision` event.
--   tenant_id    — multi-tenant bots use this; single-tenant ones leave it NULL.
--   created_at   — when the escalation was recorded.
--   resolved_at  — NULL until an operator acks. Drives the `activeOnly` filter.
--   resolved_by  — free-form identifier of the operator who resolved.
--   notes        — optional resolution notes.

CREATE TABLE IF NOT EXISTS escalations (
	id           TEXT PRIMARY KEY,
	whatsapp     TEXT NOT NULL,
	reason       TEXT NOT NULL,
	urgency      TEXT NOT NULL,
	message      TEXT NOT NULL,
	trace_id     TEXT,
	tenant_id    TEXT,
	created_at   TEXT NOT NULL DEFAULT (datetime('now')),
	resolved_at  TEXT,
	resolved_by  TEXT,
	notes        TEXT
);

CREATE INDEX IF NOT EXISTS idx_escalations_open ON escalations (resolved_at, urgency, created_at);
CREATE INDEX IF NOT EXISTS idx_escalations_whatsapp ON escalations (whatsapp, created_at);
CREATE INDEX IF NOT EXISTS idx_escalations_tenant ON escalations (tenant_id, created_at);
