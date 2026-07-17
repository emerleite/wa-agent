-- wa-agent v0.11: conversation memory for `AgentLoop`.
--
-- Distinct from `messages` (the human-readable audit log): this table
-- captures the exact structure the LLM needs to reconstruct a multi-turn,
-- tool-augmented conversation. Every step of an `AgentLoop.run(...)` writes
-- one or more rows here — assistant messages (with optional tool_calls_json)
-- + one row per tool result.
--
-- `messages` continues to hold the user-facing utterances for dashboards /
-- support review. `agent_turns` is machine state.
--
-- Apps with a bespoke schema can retarget via `tableName` + `columnMap` +
-- `omitColumns` + `allowedExtraColumns` on `ConversationMemory` — same
-- pattern as `EscalationStore` / `ConsentStore` / `AICallLedger`.
--
-- Columns:
--   id                  — UUID for this row.
--   turn_id             — UUID for a single `AgentLoop.run(...)` invocation.
--                         Correlates all rows produced by one user turn.
--   whatsapp            — user identity (E.164 string).
--   step_index          — 1-based ordinal within a turn (assistant steps advance;
--                         tool result rows share the assistant's step_index).
--   role                — 'user' | 'assistant' | 'tool'.
--   content             — plain text: user utterance | assistant text | tool output.
--   tool_calls_json     — JSON array of tool calls when role='assistant' and the
--                         model requested tool invocations. NULL for text-only.
--   tool_call_id        — echoes the provider-issued call id when role='tool'.
--                         Correlates back to the parent assistant row's
--                         tool_calls_json[i].id.
--   tool_name           — tool name when role='tool' (redundant with tool_calls_json
--                         lookup, kept for readability).
--   tenant_id           — multi-tenant scoping; single-tenant apps leave NULL.
--   created_at          — insert time.

CREATE TABLE IF NOT EXISTS agent_turns (
  id              TEXT PRIMARY KEY,
  turn_id         TEXT NOT NULL,
  whatsapp        TEXT NOT NULL,
  step_index      INTEGER NOT NULL,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  tool_calls_json TEXT,
  tool_call_id    TEXT,
  tool_name       TEXT,
  tenant_id       TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Windowed history lookup: last N rows for a user, in insertion order.
CREATE INDEX IF NOT EXISTS idx_agent_turns_user_time
  ON agent_turns (whatsapp, created_at);

-- Per-turn reconstruction: fetch all rows of a single run in order.
CREATE INDEX IF NOT EXISTS idx_agent_turns_turn_step
  ON agent_turns (turn_id, step_index);

-- Tenant scoping.
CREATE INDEX IF NOT EXISTS idx_agent_turns_tenant_user_time
  ON agent_turns (tenant_id, whatsapp, created_at);
