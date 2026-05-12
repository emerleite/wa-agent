import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { and, eq } from 'drizzle-orm';
import { ChannelOptOuts } from '../../src/channel/channel_opt_outs.js';
import { createDb } from '../../src/db/client.js';
import { leads } from '../../src/db/schema/leads.js';

const d1 = (env as { DB: D1Database }).DB;
const db = createDb(d1);

beforeEach(async () => {
	await d1.prepare('DELETE FROM channel_opt_outs').run();
	await d1.prepare('DELETE FROM leads').run();
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
		const r = await d1.prepare(`SELECT COUNT(*) as c FROM channel_opt_outs WHERE whatsapp = '5551'`).first<{ c: number }>();
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

	describe('notOptedOut (Drizzle fragment)', () => {
		it('filters audience queries correctly', async () => {
			// Seed three lead rows; mute one.
			for (const wa of ['5551', '5552', '5553']) {
				await d1.prepare(`INSERT INTO leads (whatsapp, ad_data, opt_in) VALUES (?, '{}', 1)`).bind(wa).run();
			}
			await opts.optOut('5551', 'devotional');

			const r = await db.select({ whatsapp: leads.whatsapp }).from(leads).where(and(eq(leads.optIn, 1), opts.notOptedOut('devotional', leads.whatsapp)));
			const remaining = r.map((x) => x.whatsapp).sort();
			expect(remaining).toEqual(['5552', '5553']);
		});

		it('opting back in restores the user to the audience', async () => {
			await d1.prepare(`INSERT INTO leads (whatsapp, ad_data, opt_in) VALUES ('5551', '{}', 1)`).run();
			await opts.optOut('5551', 'devotional');
			await opts.optIn('5551', 'devotional');
			const r = await db.select({ whatsapp: leads.whatsapp }).from(leads).where(opts.notOptedOut('devotional', leads.whatsapp));
			expect(r.map((x) => x.whatsapp)).toEqual(['5551']);
		});

		it('isolates channels in the audience filter', async () => {
			await d1.prepare(`INSERT INTO leads (whatsapp, ad_data, opt_in) VALUES ('5551', '{}', 1)`).run();
			await opts.optOut('5551', 'plan');
			// Muted on 'plan' but still on the 'devotional' audience.
			const r = await db.select({ whatsapp: leads.whatsapp }).from(leads).where(opts.notOptedOut('devotional', leads.whatsapp));
			expect(r.map((x) => x.whatsapp)).toEqual(['5551']);
		});
	});
});
