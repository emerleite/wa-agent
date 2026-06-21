-- wa-agent v0.9.2: snooze for SequentialPlan enrollments.
--
-- A user can defer today's delivery without abandoning the plan. The cron
-- audience query (`usersForDelivery`) gates on `snoozed_until > now`,
-- skipping users who explicitly snoozed. `markDelivered` clears
-- `snoozed_until` so a snooze never carries past the first successful
-- delivery (otherwise a one-day snooze becomes a permanent pause).
--
-- One explicit timestamp (not a counter) lets callers express "until
-- tomorrow morning", "until next Monday", or "until $exact_time" without
-- bespoke math.
--
-- Backward compatible: existing rows get NULL → behave exactly as before
-- (no snooze active, included in every audience query).

ALTER TABLE user_plans ADD COLUMN snoozed_until TEXT;

CREATE INDEX IF NOT EXISTS idx_user_plans_snoozed_until
  ON user_plans (snoozed_until);
