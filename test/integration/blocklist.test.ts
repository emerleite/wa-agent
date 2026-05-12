/**
 * Integration tests for the abuse blocklist.
 *
 * Covers: insert / overwrite, expiry handling, idempotent unblock, listBlocked
 * filtering, cleanup, fail-open on DB error, cache hit/miss/bust behavior.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { Blocklist } from '../../src/security/blocklist.js';
import { createDb } from '../../src/db/client.js';

const d1 = (env as { DB: D1Database }).DB;
const db = createDb(d1);

beforeEach(async () => {
	await d1.prepare('DELETE FROM blocked_numbers').run();
});

describe('Blocklist', () => {
	it('default state: nobody is blocked', async () => {
		const bl = new Blocklist({ db });
		expect(await bl.isBlocked('5551')).toBe(false);
	});

	it('block + isBlocked round-trip', async () => {
		const bl = new Blocklist({ db });
		await bl.block({ whatsapp: '5551', reason: 'spam', blockedBy: 'admin' });
		expect(await bl.isBlocked('5551')).toBe(true);
		// A different number is not affected.
		expect(await bl.isBlocked('5552')).toBe(false);
	});

	it('block is upsert — second call overwrites reason + bumps blocked_at', async () => {
		const bl = new Blocklist({ db });
		await bl.block({ whatsapp: '5551', reason: 'spam' });
		await bl.block({ whatsapp: '5551', reason: 'abuse', notes: 'escalated' });
		const list = await bl.listBlocked();
		expect(list).toHaveLength(1);
		expect(list[0]?.reason).toBe('abuse');
		expect(list[0]?.notes).toBe('escalated');
	});

	it('expired blocks do not count as active', async () => {
		const bl = new Blocklist({ db });
		await bl.block({ whatsapp: '5551', reason: 'temp', expiresAt: '2020-01-01 00:00:00' });
		// Cache hasn't seen this number — force a DB read.
		bl.clearCache();
		expect(await bl.isBlocked('5551')).toBe(false);
	});

	it('future-dated expiry IS active', async () => {
		const bl = new Blocklist({ db });
		await bl.block({ whatsapp: '5551', reason: 'temp', expiresAt: '2099-01-01 00:00:00' });
		expect(await bl.isBlocked('5551')).toBe(true);
	});

	it('unblock removes the row + busts the cache', async () => {
		const bl = new Blocklist({ db });
		await bl.block({ whatsapp: '5551', reason: 'spam' });
		// Warm the cache.
		await bl.isBlocked('5551');
		const removed = await bl.unblock('5551');
		expect(removed).toBe(true);
		expect(await bl.isBlocked('5551')).toBe(false);
	});

	it('unblock is idempotent (returns false when nothing matched)', async () => {
		const bl = new Blocklist({ db });
		expect(await bl.unblock('nobody')).toBe(false);
	});

	it('listBlocked defaults to active only', async () => {
		const bl = new Blocklist({ db });
		await bl.block({ whatsapp: '5551', reason: 'spam' });
		await bl.block({ whatsapp: '5552', reason: 'expired', expiresAt: '2020-01-01 00:00:00' });
		const active = await bl.listBlocked();
		expect(active.map((r) => r.whatsapp).sort()).toEqual(['5551']);
		const all = await bl.listBlocked({ activeOnly: false });
		expect(all.map((r) => r.whatsapp).sort()).toEqual(['5551', '5552']);
	});

	it('cleanup removes expired rows + busts their cache entries', async () => {
		const bl = new Blocklist({ db });
		await bl.block({ whatsapp: '5551', reason: 'active' });
		await bl.block({ whatsapp: '5552', reason: 'expired', expiresAt: '2020-01-01 00:00:00' });
		const removed = await bl.cleanup();
		expect(removed).toBe(1);
		const remaining = await bl.listBlocked({ activeOnly: false });
		expect(remaining.map((r) => r.whatsapp)).toEqual(['5551']);
	});

	it('cache hit avoids a second D1 round-trip', async () => {
		const bl = new Blocklist({ db });
		await bl.block({ whatsapp: '5551', reason: 'spam' });
		// Spy on the underlying D1 prepare to count round-trips.
		const spy = vi.spyOn(d1, 'prepare');
		spy.mockClear();
		await bl.isBlocked('5551'); // miss → 1 round-trip
		const firstCount = spy.mock.calls.length;
		await bl.isBlocked('5551'); // hit → no new round-trip
		const secondCount = spy.mock.calls.length;
		expect(secondCount).toBe(firstCount);
		spy.mockRestore();
	});

	it('cacheTtlMs=0 disables caching (every check hits D1)', async () => {
		const bl = new Blocklist({ db, cacheTtlMs: 0 });
		await bl.block({ whatsapp: '5551', reason: 'spam' });
		const spy = vi.spyOn(d1, 'prepare');
		spy.mockClear();
		await bl.isBlocked('5551');
		const firstCount = spy.mock.calls.length;
		await bl.isBlocked('5551');
		const secondCount = spy.mock.calls.length;
		expect(secondCount).toBeGreaterThan(firstCount);
		spy.mockRestore();
	});

	it('fail-open: D1 throw returns false (does not crash the bot)', async () => {
		const bl = new Blocklist({ db, cacheTtlMs: 0 });
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		// Temporarily swap select() with a throwing version.
		const origSelect = bl.db.select.bind(bl.db);
		bl.db.select = (() => {
			throw new Error('D1 down');
		}) as typeof bl.db.select;
		try {
			expect(await bl.isBlocked('5551')).toBe(false);
			expect(spy).toHaveBeenCalled();
		} finally {
			bl.db.select = origSelect;
			spy.mockRestore();
		}
	});

	it('rejects block() without whatsapp or reason', async () => {
		const bl = new Blocklist({ db });
		await expect(bl.block({ whatsapp: '', reason: 'x' })).rejects.toThrow();
		await expect(bl.block({ whatsapp: '5551', reason: '' })).rejects.toThrow();
	});

	it('empty whatsapp short-circuits isBlocked to false (no DB hit)', async () => {
		const bl = new Blocklist({ db });
		const spy = vi.spyOn(d1, 'prepare');
		spy.mockClear();
		expect(await bl.isBlocked('')).toBe(false);
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});
});
