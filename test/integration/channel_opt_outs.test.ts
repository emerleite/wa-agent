import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { ChannelOptOuts } from '../../src/channel/channel_opt_outs.js';

const db = (env as { DB: D1Database }).DB;

beforeEach(async () => {
	await db.prepare('DELETE FROM channel_opt_outs').run();
});

describe('ChannelOptOuts', () => {
	const opts = new ChannelOptOuts({ db });

	it('default state is subscribed (no row, not opted out)', async () => {
		expect(await opts.isOptedOut('5551', 'devotional')).toBe(false);
	});

	it('optOut inserts a row', async () => {
		await opts.optOut('5551', 'devotional');
		expect(await opts.isOptedOut('5551', 'devotional')).toBe(true);
	});

	it('optOut is idempotent', async () => {
		await opts.optOut('5551', 'devotional');
		await opts.optOut('5551', 'devotional');
		const r = await db.prepare(`SELECT COUNT(*) as c FROM channel_opt_outs WHERE whatsapp = '5551'`).first<{ c: number }>();
		expect(r?.c).toBe(1);
	});

	it('optIn deletes the row', async () => {
		await opts.optOut('5551', 'devotional');
		await opts.optIn('5551', 'devotional');
		expect(await opts.isOptedOut('5551', 'devotional')).toBe(false);
	});

	it('optIn is idempotent (no row to delete)', async () => {
		await expect(opts.optIn('5551', 'devotional')).resolves.toBeUndefined();
	});

	it('isolates per channel', async () => {
		await opts.optOut('5551', 'devotional');
		expect(await opts.isOptedOut('5551', 'devotional')).toBe(true);
		expect(await opts.isOptedOut('5551', 'plan')).toBe(false);
	});

	it('isolates per user', async () => {
		await opts.optOut('5551', 'devotional');
		expect(await opts.isOptedOut('5551', 'devotional')).toBe(true);
		expect(await opts.isOptedOut('5552', 'devotional')).toBe(false);
	});

	it('listOptOuts returns the channels this user has muted', async () => {
		await opts.optOut('5551', 'devotional');
		await opts.optOut('5551', 'plan');
		await opts.optOut('5552', 'devotional');
		const list = await opts.listOptOuts('5551');
		expect(list.sort()).toEqual(['devotional', 'plan']);
	});

	it('listOptedOutFor returns users muted from a channel', async () => {
		await opts.optOut('5551', 'devotional');
		await opts.optOut('5552', 'devotional');
		await opts.optOut('5553', 'plan');
		const list = await opts.listOptedOutFor('devotional');
		expect(list.sort()).toEqual(['5551', '5552']);
	});

	describe('notOptedOutSql', () => {
		it('returns a NOT EXISTS fragment', () => {
			const sql = opts.notOptedOutSql('devotional');
			expect(sql).toContain('NOT EXISTS');
			expect(sql).toContain("co.channel = 'devotional'");
		});

		it('uses qualified user expr when supplied', () => {
			const sql = opts.notOptedOutSql('devotional', 'mw.whatsapp');
			expect(sql).toContain('co.whatsapp = mw.whatsapp');
		});

		it('filters audience queries correctly', async () => {
			// Seed three users; mute one
			await opts.optOut('5551', 'devotional');
			// Qualified user expression — required when the outer query has a column
			// named `whatsapp` that would otherwise shadow the correlated subquery.
			const sql = `
				WITH u(whatsapp) AS (SELECT '5551' UNION SELECT '5552' UNION SELECT '5553')
				SELECT u.whatsapp FROM u WHERE ${opts.notOptedOutSql('devotional', 'u.whatsapp')}
				ORDER BY u.whatsapp`;
			const r = await db.prepare(sql).all<{ whatsapp: string }>();
			expect(r.results?.map((x) => x.whatsapp)).toEqual(['5552', '5553']);
		});

		it('escapes single quotes in channel name', () => {
			const sql = opts.notOptedOutSql("o'reilly");
			expect(sql).toContain("co.channel = 'o''reilly'");
		});
	});
});
