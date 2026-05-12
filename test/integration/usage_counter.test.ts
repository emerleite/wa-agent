import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { UsageCounter } from '../../src/usage/usage_counter.js';
import { createDb } from '../../src/db/client.js';

const d1 = (env as { DB: D1Database }).DB;
const db = createDb(d1);

beforeEach(async () => {
	await d1.prepare('DELETE FROM feature_usage').run();
});

describe('UsageCounter', () => {
	const counter = new UsageCounter({ db });

	it('record() inserts a row with feature + key', async () => {
		await counter.record('5551', 'image_gen', 'verse:jo:3:16');
		const row = await d1.prepare("SELECT * FROM feature_usage WHERE whatsapp = '5551'").first<{ feature: string; key: string }>();
		expect(row?.feature).toBe('image_gen');
		expect(row?.key).toBe('verse:jo:3:16');
	});

	it('record() works with null key', async () => {
		await counter.record('5551', 'tts');
		const row = await d1.prepare("SELECT key FROM feature_usage WHERE whatsapp = '5551'").first<{ key: string | null }>();
		expect(row?.key).toBeNull();
	});

	it('getDailyCount counts only today + only that user/feature', async () => {
		await counter.record('5551', 'tts');
		await counter.record('5551', 'tts');
		await counter.record('5551', 'image_gen');
		await counter.record('5552', 'tts');
		// Backdate one to yesterday
		await d1.prepare(`INSERT INTO feature_usage (whatsapp, feature, used_at) VALUES ('5551', 'tts', datetime('now', '-1 day'))`).run();

		expect(await counter.getDailyCount('5551', 'tts')).toBe(2);
		expect(await counter.getDailyCount('5551', 'image_gen')).toBe(1);
		expect(await counter.getDailyCount('5552', 'tts')).toBe(1);
		expect(await counter.getDailyCount('unknown', 'tts')).toBe(0);
	});

	it('getLifetimeCount counts all time', async () => {
		await counter.record('5551', 'tts');
		await d1.prepare(`INSERT INTO feature_usage (whatsapp, feature, used_at) VALUES ('5551', 'tts', datetime('now', '-30 days'))`).run();
		expect(await counter.getLifetimeCount('5551', 'tts')).toBe(2);
	});

	it('tryRecordWithCap allows under cap', async () => {
		expect(await counter.tryRecordWithCap('5551', 'tts', 3)).toBe(true);
		expect(await counter.tryRecordWithCap('5551', 'tts', 3)).toBe(true);
		expect(await counter.tryRecordWithCap('5551', 'tts', 3)).toBe(true);
		expect(await counter.getDailyCount('5551', 'tts')).toBe(3);
	});

	it('tryRecordWithCap rejects when at or above cap', async () => {
		await counter.record('5551', 'tts');
		await counter.record('5551', 'tts');
		expect(await counter.tryRecordWithCap('5551', 'tts', 2)).toBe(false);
		expect(await counter.getDailyCount('5551', 'tts')).toBe(2); // not bumped
	});

	it('tryRecordWithCap is per-feature (one feature does not block another)', async () => {
		await counter.tryRecordWithCap('5551', 'tts', 1);
		expect(await counter.tryRecordWithCap('5551', 'image_gen', 1)).toBe(true);
	});

	it('distinctUsersSince counts unique whatsapp values', async () => {
		await counter.record('5551', 'tts');
		await counter.record('5551', 'tts');
		await counter.record('5552', 'tts');
		await counter.record('5553', 'image_gen');
		expect(await counter.distinctUsersSince('tts')).toBe(2);
		expect(await counter.distinctUsersSince('image_gen')).toBe(1);
		expect(await counter.distinctUsersSince('nope')).toBe(0);
	});
});
