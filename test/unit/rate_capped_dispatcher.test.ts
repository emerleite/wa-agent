import { describe, it, expect, vi } from 'vitest';
import { RateCappedDispatcher } from '../../src/scheduler/rate_capped_dispatcher.js';
import type { UsageCounter } from '../../src/usage/usage_counter.js';
import type { QuietHours } from '../../src/util/quiet_hours.js';

function fakeCounter(initialDaily = 0) {
	let count = initialDaily;
	const recorded: Array<{ whatsapp: string; feature: string; key: string | null }> = [];
	return {
		getDailyCount: vi.fn(async () => count),
		record: vi.fn(async (whatsapp: string, feature: string, key: string | null) => {
			recorded.push({ whatsapp, feature, key });
			count += 1;
			return true;
		}),
		_set(n: number) {
			count = n;
		},
		_recorded() {
			return recorded;
		},
		db: {} as unknown,
	} as unknown as UsageCounter & {
		getDailyCount: ReturnType<typeof vi.fn>;
		record: ReturnType<typeof vi.fn>;
		_set(n: number): void;
		_recorded(): Array<{ whatsapp: string; feature: string; key: string | null }>;
	};
}

function noLastDispatch(d: RateCappedDispatcher) {
	(d as unknown as { lastDispatchedAt: (w: string) => Promise<number | null> }).lastDispatchedAt = async () => null;
	return d;
}

function lastDispatchAtMsAgo(d: RateCappedDispatcher, ms: number) {
	(d as unknown as { lastDispatchedAt: (w: string) => Promise<number | null> }).lastDispatchedAt = async () => Date.now() - ms;
	return d;
}

describe('RateCappedDispatcher — config', () => {
	it('throws when counter is missing', () => {
		expect(
			// @ts-expect-error testing
			() => new RateCappedDispatcher({ feature: 'x', dailyMax: 1 }),
		).toThrow();
	});

	it('throws when feature is missing or empty', () => {
		const counter = fakeCounter();
		// @ts-expect-error testing
		expect(() => new RateCappedDispatcher({ counter, dailyMax: 1 })).toThrow();
		expect(() => new RateCappedDispatcher({ counter, feature: '', dailyMax: 1 })).toThrow();
	});

	it('throws on negative or non-finite dailyMax', () => {
		const counter = fakeCounter();
		expect(() => new RateCappedDispatcher({ counter, feature: 'x', dailyMax: -1 })).toThrow();
		expect(() => new RateCappedDispatcher({ counter, feature: 'x', dailyMax: NaN })).toThrow();
	});

	it('accepts dailyMax = 0 (cap immediately)', () => {
		const counter = fakeCounter();
		expect(() => new RateCappedDispatcher({ counter, feature: 'x', dailyMax: 0 })).not.toThrow();
	});
});

describe('RateCappedDispatcher.tryDispatch — guards', () => {
	it('returns no_whatsapp when caller passes empty', async () => {
		const counter = fakeCounter();
		const d = noLastDispatch(new RateCappedDispatcher({ counter, feature: 'ad', dailyMax: 1 }));
		const send = vi.fn();
		const r = await d.tryDispatch('', send);
		expect(r).toEqual({ sent: false, reason: 'no_whatsapp' });
		expect(send).not.toHaveBeenCalled();
		expect(counter.getDailyCount).not.toHaveBeenCalled();
	});

	it('quiet_hours short-circuits before reading the counter', async () => {
		const counter = fakeCounter();
		const qh = { isQuiet: () => true } as unknown as QuietHours;
		const d = noLastDispatch(new RateCappedDispatcher({ counter, feature: 'ad', dailyMax: 1, quietHours: qh }));
		const send = vi.fn();
		const r = await d.tryDispatch('5551', send);
		expect(r).toEqual({ sent: false, reason: 'quiet_hours' });
		expect(send).not.toHaveBeenCalled();
		expect(counter.getDailyCount).not.toHaveBeenCalled();
	});

	it('quiet_hours.isQuiet === false lets the call through', async () => {
		const counter = fakeCounter();
		const qh = { isQuiet: () => false } as unknown as QuietHours;
		const d = noLastDispatch(new RateCappedDispatcher({ counter, feature: 'ad', dailyMax: 1, quietHours: qh }));
		const r = await d.tryDispatch('5551', async () => true);
		expect(r.sent).toBe(true);
	});

	it('min_gap blocks when last dispatch is inside the window', async () => {
		const counter = fakeCounter();
		const d = lastDispatchAtMsAgo(
			new RateCappedDispatcher({ counter, feature: 'ad', dailyMax: 5, minGapSeconds: 3600 }),
			60_000,
		);
		const send = vi.fn();
		const r = await d.tryDispatch('5551', send);
		expect(r).toEqual({ sent: false, reason: 'min_gap' });
		expect(send).not.toHaveBeenCalled();
		expect(counter.getDailyCount).not.toHaveBeenCalled();
	});

	it('min_gap passes when last dispatch is older than the window', async () => {
		const counter = fakeCounter();
		const d = lastDispatchAtMsAgo(
			new RateCappedDispatcher({ counter, feature: 'ad', dailyMax: 5, minGapSeconds: 60 }),
			120_000,
		);
		const r = await d.tryDispatch('5551', async () => true);
		expect(r.sent).toBe(true);
	});

	it('min_gap edge — exactly at the window is allowed (strict <)', async () => {
		const counter = fakeCounter();
		const d = lastDispatchAtMsAgo(
			new RateCappedDispatcher({ counter, feature: 'ad', dailyMax: 5, minGapSeconds: 1 }),
			1_000,
		);
		const r = await d.tryDispatch('5551', async () => true);
		expect(r.sent).toBe(true);
	});

	it('min_gap=0 skips the gap query entirely', async () => {
		const counter = fakeCounter();
		const d = new RateCappedDispatcher({ counter, feature: 'ad', dailyMax: 5, minGapSeconds: 0 });
		const lastSpy = vi.fn(async () => Date.now() - 1);
		(d as unknown as { lastDispatchedAt: () => Promise<number | null> }).lastDispatchedAt = lastSpy;
		const r = await d.tryDispatch('5551', async () => true);
		expect(r.sent).toBe(true);
		expect(lastSpy).not.toHaveBeenCalled();
	});

	it('min_gap allowed when no prior dispatch exists', async () => {
		const counter = fakeCounter();
		const d = noLastDispatch(new RateCappedDispatcher({ counter, feature: 'ad', dailyMax: 5, minGapSeconds: 3600 }));
		const r = await d.tryDispatch('5551', async () => true);
		expect(r.sent).toBe(true);
	});

	it('daily_cap blocks at exactly the cap (>= test)', async () => {
		const counter = fakeCounter(5);
		const d = noLastDispatch(new RateCappedDispatcher({ counter, feature: 'ad', dailyMax: 5 }));
		const send = vi.fn();
		const r = await d.tryDispatch('5551', send);
		expect(r).toEqual({ sent: false, reason: 'daily_cap' });
		expect(send).not.toHaveBeenCalled();
	});

	it('daily_cap allows when count is below the cap', async () => {
		const counter = fakeCounter(4);
		const d = noLastDispatch(new RateCappedDispatcher({ counter, feature: 'ad', dailyMax: 5 }));
		const r = await d.tryDispatch('5551', async () => true);
		expect(r.sent).toBe(true);
	});

	it('daily_cap of 0 always blocks', async () => {
		const counter = fakeCounter();
		const d = noLastDispatch(new RateCappedDispatcher({ counter, feature: 'ad', dailyMax: 0 }));
		const send = vi.fn();
		const r = await d.tryDispatch('5551', send);
		expect(r).toEqual({ sent: false, reason: 'daily_cap' });
		expect(send).not.toHaveBeenCalled();
	});
});

describe('RateCappedDispatcher.tryDispatch — send + record', () => {
	it('records on success', async () => {
		const counter = fakeCounter();
		const d = noLastDispatch(new RateCappedDispatcher({ counter, feature: 'ad', dailyMax: 5 }));
		const r = await d.tryDispatch('5551', async () => true);
		expect(r).toEqual({ sent: true, reason: 'sent' });
		expect(counter.record).toHaveBeenCalledWith('5551', 'ad', null);
	});

	it('forwards the key argument to record()', async () => {
		const counter = fakeCounter();
		const d = noLastDispatch(new RateCappedDispatcher({ counter, feature: 'ad', dailyMax: 5 }));
		await d.tryDispatch('5551', async () => true, 'campaign-42');
		expect(counter.record).toHaveBeenCalledWith('5551', 'ad', 'campaign-42');
	});

	it('void return from send is treated as delivered', async () => {
		const counter = fakeCounter();
		const d = noLastDispatch(new RateCappedDispatcher({ counter, feature: 'ad', dailyMax: 5 }));
		const r = await d.tryDispatch('5551', async () => {});
		expect(r.sent).toBe(true);
		expect(counter.record).toHaveBeenCalled();
	});

	it('does NOT record when send returns false', async () => {
		const counter = fakeCounter();
		const d = noLastDispatch(new RateCappedDispatcher({ counter, feature: 'ad', dailyMax: 5 }));
		const r = await d.tryDispatch('5551', async () => false);
		expect(r).toEqual({ sent: false, reason: 'send_failed' });
		expect(counter.record).not.toHaveBeenCalled();
	});

	it('does NOT record when send returns 0 or empty string', async () => {
		const counter = fakeCounter();
		const d = noLastDispatch(new RateCappedDispatcher({ counter, feature: 'ad', dailyMax: 5 }));
		// @ts-expect-error testing — runtime falsy values should be caught
		expect((await d.tryDispatch('5551', async () => 0)).reason).toBe('send_failed');
		// @ts-expect-error testing
		expect((await d.tryDispatch('5551', async () => '')).reason).toBe('send_failed');
		expect(counter.record).not.toHaveBeenCalled();
	});

	it('catches throw inside send → send_failed; no record', async () => {
		const counter = fakeCounter();
		const d = noLastDispatch(new RateCappedDispatcher({ counter, feature: 'ad', dailyMax: 5 }));
		const r = await d.tryDispatch('5551', async () => {
			throw new Error('upstream down');
		});
		expect(r).toEqual({ sent: false, reason: 'send_failed' });
		expect(counter.record).not.toHaveBeenCalled();
	});

	it('records once per successful call', async () => {
		const counter = fakeCounter();
		const d = noLastDispatch(new RateCappedDispatcher({ counter, feature: 'ad', dailyMax: 5 }));
		await d.tryDispatch('5551', async () => true);
		expect(counter.record).toHaveBeenCalledTimes(1);
	});
});
