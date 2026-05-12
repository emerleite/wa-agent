import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { PreferenceStore, definePreference } from '../../src/preference/preference_store.js';
import { createDb } from '../../src/db/client.js';

const d1 = (env as { DB: D1Database }).DB;
const db = createDb(d1);

beforeEach(async () => {
	await d1.prepare('DELETE FROM user_preferences').run();
});

describe('PreferenceStore', () => {
	const prefs = new PreferenceStore({ db });

	it('get() returns the default when no row exists', async () => {
		expect(await prefs.get('5551', 'delivery_mode', 'both')).toBe('both');
		expect(await prefs.get('5551', 'language')).toBeNull();
	});

	it('set() persists and get() retrieves', async () => {
		expect(await prefs.set('5551', 'delivery_mode', 'audio')).toBe(true);
		expect(await prefs.get('5551', 'delivery_mode')).toBe('audio');
	});

	it('set() upserts (replaces existing value)', async () => {
		await prefs.set('5551', 'delivery_mode', 'audio');
		await prefs.set('5551', 'delivery_mode', 'text');
		expect(await prefs.get('5551', 'delivery_mode')).toBe('text');
	});

	it('set() with allowed rejects values outside the list', async () => {
		const ok = await prefs.set('5551', 'delivery_mode', 'audio', { allowed: ['text', 'audio', 'both'] });
		const bad = await prefs.set('5551', 'delivery_mode', 'video', { allowed: ['text', 'audio', 'both'] });
		expect(ok).toBe(true);
		expect(bad).toBe(false);
		expect(await prefs.get('5551', 'delivery_mode')).toBe('audio'); // unchanged
	});

	it('clear() removes the row', async () => {
		await prefs.set('5551', 'delivery_mode', 'audio');
		await prefs.clear('5551', 'delivery_mode');
		expect(await prefs.get('5551', 'delivery_mode')).toBeNull();
	});

	it('getAll() returns a map of all prefs for one user', async () => {
		await prefs.set('5551', 'delivery_mode', 'audio');
		await prefs.set('5551', 'language', 'pt');
		await prefs.set('5552', 'delivery_mode', 'text');

		const map = await prefs.getAll('5551');
		expect(map).toEqual({ delivery_mode: 'audio', language: 'pt' });
	});

	it('isolates preferences across users', async () => {
		await prefs.set('5551', 'delivery_mode', 'audio');
		await prefs.set('5552', 'delivery_mode', 'text');
		expect(await prefs.get('5551', 'delivery_mode')).toBe('audio');
		expect(await prefs.get('5552', 'delivery_mode')).toBe('text');
	});

	it('updated_at advances on each set', async () => {
		await prefs.set('5551', 'delivery_mode', 'audio');
		await d1.prepare(`UPDATE user_preferences SET updated_at = datetime('now', '-10 minutes') WHERE whatsapp = '5551'`).run();
		await prefs.set('5551', 'delivery_mode', 'text');
		const row = await d1
			.prepare(`SELECT julianday('now') - julianday(updated_at) AS age FROM user_preferences WHERE whatsapp = '5551'`)
			.first<{ age: number }>();
		expect((row?.age ?? 1) * 24 * 60).toBeLessThan(1); // < 1 minute old
	});
});

describe('definePreference', () => {
	const prefs = new PreferenceStore({ db });
	const deliveryMode = definePreference('delivery_mode', 'both', ['text', 'audio', 'both'] as const);

	it('get() returns the configured default when nothing is stored', async () => {
		expect(await deliveryMode.get(prefs, '5551')).toBe('both');
	});

	it('set() validates against allowed and persists', async () => {
		expect(await deliveryMode.set(prefs, '5551', 'audio')).toBe(true);
		expect(await deliveryMode.get(prefs, '5551')).toBe('audio');
	});

	it('set() rejects values outside allowed', async () => {
		// @ts-expect-error TS catches this at compile-time, runtime check still rejects
		expect(await deliveryMode.set(prefs, '5551', 'video')).toBe(false);
	});

	it('definitions can omit allowed for free-form prefs', async () => {
		const language = definePreference<string>('language', 'en');
		expect(await language.set(prefs, '5551', 'anything')).toBe(true);
		expect(await language.get(prefs, '5551')).toBe('anything');
	});
});
