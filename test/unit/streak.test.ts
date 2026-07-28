import { describe, it, expect } from 'vitest';
import { brtToday, dayDelta, nextStreak } from '../../src/util/streak.js';

describe('brtToday', () => {
	it('subtracts 3h from `now` before slicing the ISO date', () => {
		// 2026-01-02 02:00 UTC → 2026-01-01 23:00 BRT → "2026-01-01"
		const utc = Date.UTC(2026, 0, 2, 2, 0, 0);
		expect(brtToday(utc)).toBe('2026-01-01');
	});
	it('respects the UTC boundary at BRT midnight', () => {
		// 2026-01-02 03:00 UTC = 2026-01-02 00:00 BRT
		expect(brtToday(Date.UTC(2026, 0, 2, 3, 0, 0))).toBe('2026-01-02');
	});
});

describe('dayDelta', () => {
	it('returns 0 for the same day', () => {
		expect(dayDelta('2026-01-01', '2026-01-01')).toBe(0);
	});
	it('returns positive for future days', () => {
		expect(dayDelta('2026-01-01', '2026-01-02')).toBe(1);
		expect(dayDelta('2026-01-01', '2026-01-10')).toBe(9);
	});
	it('returns negative for past days', () => {
		expect(dayDelta('2026-01-05', '2026-01-01')).toBe(-4);
	});
	it('handles month boundaries', () => {
		expect(dayDelta('2026-01-31', '2026-02-01')).toBe(1);
	});
	it('handles year boundaries + leap years', () => {
		expect(dayDelta('2024-02-28', '2024-03-01')).toBe(2); // 2024 is leap
	});
});

describe('nextStreak', () => {
	it('starts a new streak when prev is null', () => {
		expect(nextStreak(null, '2026-01-01')).toEqual({ count: 1, last_day: '2026-01-01', started_at: '2026-01-01' });
	});
	it('is idempotent when re-touched on the same day', () => {
		const prev = { count: 3, last_day: '2026-01-01', started_at: '2025-12-30' };
		expect(nextStreak(prev, '2026-01-01')).toBe(prev);
	});
	it('bumps count when consecutive-day touch', () => {
		const prev = { count: 3, last_day: '2026-01-01', started_at: '2025-12-30' };
		expect(nextStreak(prev, '2026-01-02')).toEqual({ count: 4, last_day: '2026-01-02', started_at: '2025-12-30' });
	});
	it('resets to 1 when there was a gap > 1 day', () => {
		const prev = { count: 5, last_day: '2026-01-01', started_at: '2025-12-28' };
		expect(nextStreak(prev, '2026-01-05')).toEqual({ count: 1, last_day: '2026-01-05', started_at: '2026-01-05' });
	});
	it('leaves alone when `today` is behind `last_day` (clock drift / backfill)', () => {
		const prev = { count: 3, last_day: '2026-01-05', started_at: '2026-01-03' };
		expect(nextStreak(prev, '2026-01-04')).toBe(prev);
	});
	it('carries started_at forward when prev.started_at is empty (legacy row)', () => {
		const prev = { count: 3, last_day: '2026-01-01', started_at: '' };
		expect(nextStreak(prev, '2026-01-02')).toEqual({ count: 4, last_day: '2026-01-02', started_at: '2026-01-01' });
	});
});
