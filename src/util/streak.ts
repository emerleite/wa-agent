/**
 * Cross-device reading / activity streak — pure day-math.
 *
 * The streak grain is a Brazil-timezone (BRT, UTC-3, no DST) calendar day.
 * Brazil doesn't observe DST anymore so a fixed -3h offset is stable; this
 * matches D1's typical `date('now','-3 hours')` convention. If you serve a
 * non-BR audience, `brtToday` is misnamed for you — use your own boundary
 * function and pass the resulting `YYYY-MM-DD` string to `nextStreak`.
 *
 *   const today = brtToday();
 *   const next = nextStreak(prevRow, today);
 *   // next = { count, last_day, started_at }
 *
 * These are pure functions on purpose — persistence is your D1 table shape.
 * A `StreakStore` class with the framework's `columnMap` / `tableName` flex
 * may come in a later release if enough consumers reinvent the same UPSERT.
 */

/** Today's BRT calendar day as `YYYY-MM-DD`. */
export function brtToday(now: number = Date.now()): string {
	const t = now - 3 * 3600 * 1000;
	return new Date(t).toISOString().slice(0, 10);
}

/** Whole-day delta from `a` to `b` (both `YYYY-MM-DD`). Negative if `b` precedes `a`. */
export function dayDelta(a: string, b: string): number {
	const pa = a.split('-').map(Number);
	const pb = b.split('-').map(Number);
	const da = Date.UTC(pa[0]!, pa[1]! - 1, pa[2]!);
	const dbz = Date.UTC(pb[0]!, pb[1]! - 1, pb[2]!);
	return Math.round((dbz - da) / 86400000);
}

export interface StreakRow {
	count: number;
	last_day: string;
	started_at: string;
}

/**
 * Compute the next streak row from the previous one and today's calendar day.
 *
 *   no prev              → start at count=1, last_day=today, started_at=today
 *   prev.last_day == today → no-op (idempotent re-touch)
 *   delta == 1           → bump (consecutive day)
 *   delta > 1            → reset to 1 (gap broke the streak)
 *   delta <= 0           → leave alone (clock drift / time travel)
 */
export function nextStreak(prev: StreakRow | null, today: string): StreakRow {
	if (!prev) return { count: 1, last_day: today, started_at: today };
	if (prev.last_day === today) return prev;
	const delta = dayDelta(prev.last_day, today);
	if (delta === 1) {
		return {
			count: prev.count + 1,
			last_day: today,
			started_at: prev.started_at || prev.last_day,
		};
	}
	if (delta > 1) return { count: 1, last_day: today, started_at: today };
	return prev;
}
