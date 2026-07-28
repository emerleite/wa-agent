import { describe, it, expect, vi } from 'vitest';
import { createD1ChainResolver } from '../../src/ai/router.js';

function makeDb(rows: Record<string, string | null>) {
	const calls: string[] = [];
	const db = {
		prepare(_sql: string) {
			return {
				bind(task: string) {
					calls.push(task);
					return {
						async first<T>(): Promise<T | null> {
							const chain = rows[task];
							if (chain === undefined) return null;
							return { chain } as unknown as T;
						},
					};
				},
			};
		},
	};
	return { db, calls };
}

describe('createD1ChainResolver', () => {
	it('returns chain from D1 as string[]', async () => {
		const { db } = makeDb({ classifier: 'groq_70b,workers_ai' });
		const resolve = createD1ChainResolver({ db });
		expect(await resolve('classifier')).toEqual(['groq_70b', 'workers_ai']);
	});

	it('falls back to secondary resolver when D1 has no row', async () => {
		const { db } = makeDb({});
		const fallback = vi.fn(() => ['cerebras', 'workers_ai']);
		const resolve = createD1ChainResolver({ db, fallback });
		expect(await resolve('classifier')).toEqual(['cerebras', 'workers_ai']);
		expect(fallback).toHaveBeenCalledWith('classifier');
	});

	it('returns [] when D1 misses AND no fallback', async () => {
		const { db } = makeDb({});
		const resolve = createD1ChainResolver({ db });
		expect(await resolve('classifier')).toEqual([]);
	});

	it('caches per-task for cacheMs (second call hits cache)', async () => {
		const { db, calls } = makeDb({ classifier: 'a,b' });
		let now = 1_000;
		const resolve = createD1ChainResolver({ db, cacheMs: 60_000, now: () => now });
		await resolve('classifier');
		await resolve('classifier');
		await resolve('classifier');
		expect(calls).toEqual(['classifier']); // 1 D1 call, 2 cache hits
	});

	it('cache expires after cacheMs', async () => {
		const { db, calls } = makeDb({ classifier: 'a,b' });
		let now = 1_000;
		const resolve = createD1ChainResolver({ db, cacheMs: 500, now: () => now });
		await resolve('classifier');
		now += 400; // still fresh
		await resolve('classifier');
		now += 200; // expired
		await resolve('classifier');
		expect(calls).toEqual(['classifier', 'classifier']);
	});

	it('cacheMs=0 disables caching', async () => {
		const { db, calls } = makeDb({ classifier: 'a,b' });
		const resolve = createD1ChainResolver({ db, cacheMs: 0 });
		await resolve('classifier');
		await resolve('classifier');
		expect(calls.length).toBe(2);
	});

	it('trims whitespace and drops empty entries', async () => {
		const { db } = makeDb({ classifier: ' a , , b ,c ' });
		const resolve = createD1ChainResolver({ db });
		expect(await resolve('classifier')).toEqual(['a', 'b', 'c']);
	});

	it('empty / whitespace-only chain string falls through to fallback', async () => {
		const { db } = makeDb({ classifier: '   ' });
		const fallback = () => ['fb'];
		const resolve = createD1ChainResolver({ db, fallback });
		expect(await resolve('classifier')).toEqual(['fb']);
	});

	it('swallows D1 read errors and falls through to fallback', async () => {
		const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
		const db = {
			prepare() {
				return { bind() { return { async first() { throw new Error('D1 down'); } }; } };
			},
		};
		const fallback = () => ['fb'];
		const resolve = createD1ChainResolver({ db, fallback });
		expect(await resolve('classifier')).toEqual(['fb']);
		expect(spy).toHaveBeenCalled();
		spy.mockRestore();
	});

	it('rejects tableName / column names with non-identifier characters', () => {
		const { db } = makeDb({});
		expect(() => createD1ChainResolver({ db, tableName: "x; DROP TABLE users;--" })).toThrow(/tableName/);
		expect(() => createD1ChainResolver({ db, taskColumn: 'task col' })).toThrow(/taskColumn/);
		expect(() => createD1ChainResolver({ db, chainColumn: '' })).toThrow(/chainColumn/);
	});

	it('accepts an async fallback', async () => {
		const { db } = makeDb({});
		const resolve = createD1ChainResolver({ db, fallback: async () => ['async_fb'] });
		expect(await resolve('classifier')).toEqual(['async_fb']);
	});
});
