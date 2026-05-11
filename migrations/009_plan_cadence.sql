-- wa-agent: per-enrollment delivery-cadence gate for SequentialPlan.
--
-- Before this migration, `usersForDelivery` deduped on the calendar date of
-- `progress.completed_at`. That created a cross-midnight burst: deliver at
-- 23:55, user taps Done at 00:05, cron at 00:30 sees no progress dated today
-- and ships the next day immediately (~30 min after the previous send).
--
-- Bibliafala observed a power-clicker cycle through 4 days in one afternoon
-- (5521981144885, 2026-05-08, days 10/11/12/13 between 10:25 and 22:55 UTC).
--
-- Fix: a per-enrollment `last_delivered_at` timestamp. The cron's audience
-- filter requires it be NULL or older than ~20h. Click-and-cron races no
-- longer trigger an immediate redelivery.
--
-- Backfill from MAX(completed_at) of existing progress rows so active
-- enrollees don't flood at the next cron tick on rollout.

ALTER TABLE user_plans ADD COLUMN last_delivered_at TEXT;

UPDATE user_plans
SET last_delivered_at = (
	SELECT MAX(pp.completed_at)
	FROM user_plan_progress pp
	WHERE pp.whatsapp = user_plans.whatsapp AND pp.plan_id = user_plans.plan_id
)
WHERE is_active = 1;

CREATE INDEX IF NOT EXISTS idx_user_plans_last_delivered ON user_plans (last_delivered_at);
