-- wa-agent v0.11: correlate ai_call_log rows to AgentLoop runs.
--
-- The v0.9 AICallLedger records one row per LLM call. Under `AIRouter` this
-- is typically 1 row per user response (or a few, if the cascade walked
-- past failures). Under `AgentLoop`, a single user turn may cause 5+ LLM
-- calls as tools are dispatched and the model reasons over their results.
--
-- Adding `turn_id` lets dashboards group all calls of one user turn and
-- answer: "average steps per turn?", "cost per completed turn?", "which
-- tools cause the most retries?" without joining across tables.
--
-- Nullable so existing single-shot AIRouter callers are unaffected — a
-- classifier call without a surrounding loop simply has turn_id NULL.

ALTER TABLE ai_call_log ADD COLUMN turn_id TEXT;

CREATE INDEX IF NOT EXISTS idx_ai_call_log_turn
  ON ai_call_log (turn_id);
