import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { BotSendPacing } from '../../src/scheduler/bot_send_pacing.js';

const d1 = (env as { DB: D1Database }).DB;

beforeEach(async () => {
	await d1.prepare('DELETE FROM bot_send_log').run();
});

describe('BotSendPacing — construction', () => {
	it('throws on missing db', () => {
		expect(() => new BotSendPacing({ db: null as unknown as D1Database })).toThrow();
	});

	it('rejects unsafe tableName / columnMap / allowedExtraColumns', () => {
		expect(() => new BotSendPacing({ db: d1, tableName: 'x; --' })).toThrow();
		expect(() => new BotSendPacing({ db: d1, columnMap: { whatsapp: 'wa; --' } })).toThrow();
		expect(() => new BotSendPacing({ db: d1, allowedExtraColumns: ['oops; --'] })).toThrow();
	});
});

describe('BotSendPacing — recordSent', () => {
	it('inserts a row + countSentToday picks it up', async () => {
		const p = new BotSendPacing({ db: d1 });
		expect(await p.countSentToday('5551')).toBe(0);
		await p.recordSent('5551', 'engagement');
		expect(await p.countSentToday('5551')).toBe(1);
	});

	it('rejects missing whatsapp / category', async () => {
		const p = new BotSendPacing({ db: d1 });
		await expect(p.recordSent('', 'x')).rejects.toThrow();
		await expect(p.recordSent('5551', '')).rejects.toThrow();
	});

	it('countSentToday filters by category', async () => {
		const p = new BotSendPacing({ db: d1 });
		await p.recordSent('5551', 'engagement');
		await p.recordSent('5551', 'ad');
		await p.recordSent('5551', 'ad');
		expect(await p.countSentToday('5551')).toBe(3);
		expect(await p.countSentToday('5551', 'ad')).toBe(2);
		expect(await p.countSentToday('5551', 'devotional')).toBe(0);
	});

	it('countByCategoryToday returns a per-category map', async () => {
		const p = new BotSendPacing({ db: d1 });
		await p.recordSent('5551', 'engagement');
		await p.recordSent('5551', 'ad');
		await p.recordSent('5551', 'ad');
		const map = await p.countByCategoryToday('5551');
		expect(map).toEqual({ engagement: 1, ad: 2 });
	});
});

describe('BotSendPacing — canSend gates', () => {
	it('defaults to permissive when no gates configured', async () => {
		const p = new BotSendPacing({ db: d1 });
		expect(await p.canSend('5551', { minGapMinutes: null, dailyCap: null })).toBe(true);
	});

	it('minGapMinutes blocks when there was a recent send', async () => {
		const p = new BotSendPacing({ db: d1 });
		await p.recordSent('5551', 'engagement');
		expect(await p.canSend('5551', { minGapMinutes: 60 })).toBe(false);
	});

	it('minGapMinutes allows when last send is outside the window', async () => {
		const p = new BotSendPacing({ db: d1 });
		// Insert one row with sent_at 2 hours ago (bypass recordSent default).
		await d1.prepare(
			"INSERT INTO bot_send_log (whatsapp, category, sent_at, date) VALUES (?, ?, datetime('now', '-2 hours'), date('now'))",
		).bind('5551', 'engagement').run();
		expect(await p.canSend('5551', { minGapMinutes: 60 })).toBe(true);
	});

	it('dailyCap blocks at the threshold', async () => {
		const p = new BotSendPacing({ db: d1 });
		// Three older sends today (bypass min-gap) at category=ad.
		for (let i = 0; i < 3; i++) {
			await d1.prepare(
				"INSERT INTO bot_send_log (whatsapp, category, sent_at, date) VALUES (?, 'ad', datetime('now', '-' || ? || ' hours'), date('now'))",
			).bind('5551', String(2 + i)).run();
		}
		expect(await p.canSend('5551', { category: 'ad', minGapMinutes: 0, dailyCap: 3 })).toBe(false);
		expect(await p.canSend('5551', { category: 'ad', minGapMinutes: 0, dailyCap: 4 })).toBe(true);
	});

	it('dailyCap is category-scoped when category is set', async () => {
		const p = new BotSendPacing({ db: d1 });
		for (let i = 0; i < 3; i++) {
			await d1.prepare(
				"INSERT INTO bot_send_log (whatsapp, category, sent_at, date) VALUES (?, 'ad', datetime('now', '-' || ? || ' hours'), date('now'))",
			).bind('5551', String(2 + i)).run();
		}
		// Different category, same cap → allow.
		expect(await p.canSend('5551', { category: 'devotional', minGapMinutes: 0, dailyCap: 3 })).toBe(true);
	});

	it('dailyCap without category counts every row (total cap mode)', async () => {
		const p = new BotSendPacing({ db: d1 });
		for (const cat of ['ad', 'devotional', 'engagement']) {
			await d1.prepare(
				"INSERT INTO bot_send_log (whatsapp, category, sent_at, date) VALUES (?, ?, datetime('now', '-' || ? || ' hours'), date('now'))",
			).bind('5551', cat, '3').run();
		}
		// Total 3 sends today across all categories — total cap=3 blocks.
		expect(await p.canSend('5551', { minGapMinutes: 0, dailyCap: 3 })).toBe(false);
		expect(await p.canSend('5551', { minGapMinutes: 0, dailyCap: 4 })).toBe(true);
	});

	it('returns false when whatsapp is empty', async () => {
		const p = new BotSendPacing({ db: d1 });
		expect(await p.canSend('', { dailyCap: 1 })).toBe(false);
	});
});

describe('BotSendPacing — multi-tenant scoping', () => {
	it('rows are scoped per tenant on both write + read', async () => {
		const pA = new BotSendPacing({ db: d1, tenantId: 'A' });
		const pB = new BotSendPacing({ db: d1, tenantId: 'B' });
		await pA.recordSent('5551', 'engagement');
		await pA.recordSent('5551', 'engagement');
		await pB.recordSent('5551', 'engagement');

		expect(await pA.countSentToday('5551')).toBe(2);
		expect(await pB.countSentToday('5551')).toBe(1);
	});

	it('per-tenant canSend doesn\'t see other tenants\' sends', async () => {
		const pA = new BotSendPacing({ db: d1, tenantId: 'A' });
		const pB = new BotSendPacing({ db: d1, tenantId: 'B' });
		await pA.recordSent('5551', 'engagement');

		// Tenant B has no recent sends — should allow.
		expect(await pB.canSend('5551', { minGapMinutes: 60 })).toBe(true);
		// Tenant A has a recent send — should block.
		expect(await pA.canSend('5551', { minGapMinutes: 60 })).toBe(false);
	});

	it('single-tenant deployments (no tenantId) see all rows', async () => {
		const pA = new BotSendPacing({ db: d1, tenantId: 'A' });
		const pNo = new BotSendPacing({ db: d1 });
		await pA.recordSent('5551', 'engagement');
		// Without tenantId scope, counts every row including A's.
		expect(await pNo.countSentToday('5551')).toBe(1);
	});
});

describe('BotSendPacing — extraColumns + columnMap', () => {
	it('rejects unknown extraColumns at runtime', async () => {
		const p = new BotSendPacing({ db: d1, allowedExtraColumns: [] });
		await expect(
			p.recordSent('5551', 'engagement', { extraColumns: { not_allowed: 'x' } }),
		).rejects.toThrow(/not_allowed/);
	});
});
