/**
 * Unit tests for the pure-logic parts of PreferenceStore + definePreference.
 *
 * Uses an in-memory fake D1 so the tests run in the Node pool (no Workers
 * runtime) and Stryker can drive them. SQL behavior is covered by
 * test/integration/preference_store.test.ts against real D1.
 */
import { describe, it, expect } from 'vitest';
import { PreferenceStore, definePreference } from '../../src/preference/preference_store.js';

/**
 * Minimal in-memory fake of the D1 surface PreferenceStore touches.
 * Only the call shapes used by get/set/clear/getAll need to behave.
 */
function fakeDb() {
	const store = new Map<string, string>(); // `${whatsapp}::${key}` → value
	const keyOf = (wa: string, k: string) => `${wa}::${k}`;

	const prepare = (sql: string) => {
		let bindings: unknown[] = [];
		const api = {
			bind(...args: unknown[]) {
				bindings = args;
				return api;
			},
			async first<T = unknown>(): Promise<T | null> {
				if (sql.startsWith('SELECT value')) {
					const [wa, k] = bindings as [string, string];
					const v = store.get(keyOf(wa, k));
					return v == null ? null : ({ value: v } as T);
				}
				return null;
			},
			async all<T = unknown>(): Promise<{ results: T[]; success: boolean; meta: { changes: number } }> {
				if (sql.startsWith('SELECT key, value')) {
					const [wa] = bindings as [string];
					const out: Array<{ key: string; value: string }> = [];
					for (const [k, v] of store) {
						const [user, name] = k.split('::');
						if (user === wa) out.push({ key: name!, value: v });
					}
					return { results: out as T[], success: true, meta: { changes: out.length } };
				}
				return { results: [], success: true, meta: { changes: 0 } };
			},
			async run(): Promise<{ success: boolean; meta: { changes: number; last_row_id: number } }> {
				if (sql.startsWith('INSERT INTO')) {
					const [wa, k, v] = bindings as [string, string, string];
					store.set(keyOf(wa, k), v);
					return { success: true, meta: { changes: 1, last_row_id: 1 } };
				}
				if (sql.startsWith('DELETE FROM')) {
					const [wa, k] = bindings as [string, string];
					store.delete(keyOf(wa, k));
					return { success: true, meta: { changes: 1, last_row_id: 0 } };
				}
				return { success: true, meta: { changes: 0, last_row_id: 0 } };
			},
		};
		return api;
	};

	return { _store: store, prepare } as unknown as D1Database & { _store: Map<string, string> };
}

describe('PreferenceStore — pure logic', () => {
	it('get() returns the default when no row exists', async () => {
		const ps = new PreferenceStore({ db: fakeDb() });
		expect(await ps.get('5551', 'k', 'fallback')).toBe('fallback');
	});

	it('get() returns null when no default supplied', async () => {
		const ps = new PreferenceStore({ db: fakeDb() });
		expect(await ps.get('5551', 'k')).toBeNull();
	});

	it('set() persists, get() retrieves', async () => {
		const ps = new PreferenceStore({ db: fakeDb() });
		expect(await ps.set('5551', 'k', 'v')).toBe(true);
		expect(await ps.get('5551', 'k')).toBe('v');
	});

	it('set({allowed}) rejects values outside the list and does not write', async () => {
		const db = fakeDb();
		const ps = new PreferenceStore({ db });
		const r = await ps.set('5551', 'mode', 'video', { allowed: ['text', 'audio'] });
		expect(r).toBe(false);
		expect(db._store.size).toBe(0);
	});

	it('set({allowed}) accepts values inside the list', async () => {
		const ps = new PreferenceStore({ db: fakeDb() });
		expect(await ps.set('5551', 'mode', 'audio', { allowed: ['text', 'audio'] })).toBe(true);
	});

	it('clear() removes the row', async () => {
		const ps = new PreferenceStore({ db: fakeDb() });
		await ps.set('5551', 'k', 'v');
		await ps.clear('5551', 'k');
		expect(await ps.get('5551', 'k')).toBeNull();
	});

	it('getAll() returns only the requested user’s prefs', async () => {
		const ps = new PreferenceStore({ db: fakeDb() });
		await ps.set('5551', 'a', '1');
		await ps.set('5551', 'b', '2');
		await ps.set('5552', 'a', '99');
		expect(await ps.getAll('5551')).toEqual({ a: '1', b: '2' });
		expect(await ps.getAll('5552')).toEqual({ a: '99' });
	});

	it('throws if db is missing', () => {
		// @ts-expect-error testing
		expect(() => new PreferenceStore({})).toThrow();
	});
});

describe('definePreference', () => {
	it('captures key, default, and allowed', () => {
		const p = definePreference('mode', 'both', ['text', 'audio', 'both'] as const);
		expect(p.key).toBe('mode');
		expect(p.defaultValue).toBe('both');
		expect(p.allowed).toEqual(['text', 'audio', 'both']);
	});

	it('get() returns the configured default when missing', async () => {
		const ps = new PreferenceStore({ db: fakeDb() });
		const p = definePreference('mode', 'both', ['text', 'audio', 'both'] as const);
		expect(await p.get(ps, '5551')).toBe('both');
	});

	it('set() writes through and validates against allowed', async () => {
		const ps = new PreferenceStore({ db: fakeDb() });
		const p = definePreference('mode', 'both', ['text', 'audio', 'both'] as const);
		expect(await p.set(ps, '5551', 'audio')).toBe(true);
		expect(await p.get(ps, '5551')).toBe('audio');
	});

	it('set() rejects values outside allowed', async () => {
		const ps = new PreferenceStore({ db: fakeDb() });
		const p = definePreference('mode', 'both', ['text', 'audio', 'both'] as const);
		// @ts-expect-error compile-time check; runtime should also reject
		expect(await p.set(ps, '5551', 'video')).toBe(false);
	});

	it('definitions without allowed accept any string value', async () => {
		const ps = new PreferenceStore({ db: fakeDb() });
		const p = definePreference<string>('lang', 'en');
		expect(await p.set(ps, '5551', 'ja')).toBe(true);
		expect(await p.get(ps, '5551')).toBe('ja');
	});
});
