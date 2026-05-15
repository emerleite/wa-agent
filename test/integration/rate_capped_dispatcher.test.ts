import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { UsageCounter } from '../../src/usage/usage_counter.js';
import { RateCappedDispatcher } from '../../src/scheduler/rate_capped_dispatcher.js';
import { QuietHours } from '../../src/util/quiet_hours.js';
import { createDb } from '../../src/db/client.js';

const d1 = (env as { DB: D1Database }).DB;
const db = createDb(d1);

beforeEach(async () => {
	await d1.prepare('DELETE FROM feature_usage').run();
});

describe('RateCappedDispatcher', () => {
	const counter = new UsageCounter({ db });

	it('throws on bad config', () => {
		// @ts-expect-error testing
		expect(() => new RateCappedDispatcher({})).toThrow();
		expect(() => new RateCappedDispatcher({ counter, feature: '', dailyMax: 1 })).toThrow();
		expect(() => new RateCappedDispatcher({ counter, feature: 'x', dailyMax: -1 })).toThrow();
	});

	it('returns no_whatsapp when caller passes empty', async () => {
		const d = new RateCappedDispatcher({ counter, feature: 'ad', dailyMax: 1 });
		const send = vi.fn();
		const r = await d.tryDispatch('', send);
		expect(r).toEqual({ sent: false, reason: 'no_whatsapp' });
		expect(send).not.toHaveBeenCalled();
	});

	it('dispatches and records on first call', async () => {
		const d = new RateCappedDispatcher({ counter, feature: 'ad', dailyMax: 2 });
		const send = vi.fn(async () => true);
		const r = await d.tryDispatch('5551', send);
		expect(r).toEqual({ sent: true, reason: 'sent' });
		expect(send).toHaveBeenCalledOnce();
		expect(await counter.getDailyCount('5551', 'ad')).toBe(1);
	});

	it('void return from send is treated as delivered', async () => {
		const d = new RateCappedDispatcher({ counter, feature: 'ad', dailyMax: 2 });
		const r = await d.tryDispatch('5551', async () => {});
		expect(r.sent).toBe(true);
		expect(await counter.getDailyCount('5551', 'ad')).toBe(1);
	});

	it('blocks past the daily cap without calling send', async () => {
		const d = new RateCappedDispatcher({ counter, feature: 'ad', dailyMax: 2 });
		await d.tryDispatch('5551', async () => true);
		await d.tryDispatch('5551', async () => true);
		const send = vi.fn(async () => true);
		const r = await d.tryDispatch('5551', send);
		expect(r).toEqual({ sent: false, reason: 'daily_cap' });
		expect(send).not.toHaveBeenCalled();
	});

	it('blocks during quiet hours without calling send', async () => {
		const qh = { isQuiet: () => true } as unknown as QuietHours;
		const d = new RateCappedDispatcher({ counter, feature: 'ad', dailyMax: 2, quietHours: qh });
		const send = vi.fn();
		const r = await d.tryDispatch('5551', send);
		expect(r).toEqual({ sent: false, reason: 'quiet_hours' });
		expect(send).not.toHaveBeenCalled();
	});

	it('does NOT record when send returns false', async () => {
		const d = new RateCappedDispatcher({ counter, feature: 'ad', dailyMax: 2 });
		const r = await d.tryDispatch('5551', async () => false);
		expect(r).toEqual({ sent: false, reason: 'send_failed' });
		expect(await counter.getDailyCount('5551', 'ad')).toBe(0);
	});

	it('catches a throw inside send and does not record', async () => {
		const d = new RateCappedDispatcher({ counter, feature: 'ad', dailyMax: 2 });
		const r = await d.tryDispatch('5551', async () => {
			throw new Error('upstream down');
		});
		expect(r).toEqual({ sent: false, reason: 'send_failed' });
		expect(await counter.getDailyCount('5551', 'ad')).toBe(0);
	});

	it('min_gap blocks a second call within the window', async () => {
		const d = new RateCappedDispatcher({ counter, feature: 'ad', dailyMax: 5, minGapSeconds: 3600 });
		expect((await d.tryDispatch('5551', async () => true)).sent).toBe(true);
		const r = await d.tryDispatch('5551', async () => true);
		expect(r).toEqual({ sent: false, reason: 'min_gap' });
	});

	it('min_gap passes once the previous send is older than the window', async () => {
		const d = new RateCappedDispatcher({ counter, feature: 'ad', dailyMax: 5, minGapSeconds: 3600 });
		// Backdate a usage row 2h ago.
		await d1
			.prepare(`INSERT INTO feature_usage (whatsapp, feature, used_at) VALUES ('5551', 'ad', datetime('now', '-2 hours'))`)
			.run();
		const r = await d.tryDispatch('5551', async () => true);
		expect(r).toEqual({ sent: true, reason: 'sent' });
	});

	it('min_gap is per-user (one user does not block another)', async () => {
		const d = new RateCappedDispatcher({ counter, feature: 'ad', dailyMax: 5, minGapSeconds: 3600 });
		await d.tryDispatch('5551', async () => true);
		const r = await d.tryDispatch('5552', async () => true);
		expect(r.sent).toBe(true);
	});

	it('feature partitions: another feature is unaffected', async () => {
		const ads = new RateCappedDispatcher({ counter, feature: 'ad', dailyMax: 1 });
		const tips = new RateCappedDispatcher({ counter, feature: 'tip', dailyMax: 1 });
		await ads.tryDispatch('5551', async () => true);
		expect((await ads.tryDispatch('5551', async () => true)).reason).toBe('daily_cap');
		expect((await tips.tryDispatch('5551', async () => true)).sent).toBe(true);
	});
});
