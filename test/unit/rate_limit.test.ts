import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	RateLimit,
	MemoryRateLimitStore,
	KvRateLimitStore,
	honoRateLimit,
	type HonoRateLimitContext,
	type RateLimitStore,
} from '../../src/security/rate_limit.js';

describe('RateLimit — config', () => {
	it('throws on missing store', () => {
		// @ts-expect-error testing
		expect(() => new RateLimit({ windowSeconds: 60, max: 10 })).toThrow();
	});

	it('throws on non-positive windowSeconds', () => {
		const store = new MemoryRateLimitStore();
		expect(() => new RateLimit({ store, windowSeconds: 0, max: 10 })).toThrow();
		expect(() => new RateLimit({ store, windowSeconds: -1, max: 10 })).toThrow();
		expect(() => new RateLimit({ store, windowSeconds: NaN, max: 10 })).toThrow();
	});

	it('throws on negative max', () => {
		const store = new MemoryRateLimitStore();
		expect(() => new RateLimit({ store, windowSeconds: 60, max: -1 })).toThrow();
	});

	it('accepts max = 0 (always rejects)', () => {
		const store = new MemoryRateLimitStore();
		expect(() => new RateLimit({ store, windowSeconds: 60, max: 0 })).not.toThrow();
	});
});

describe('RateLimit.check — sliding window', () => {
	let store: MemoryRateLimitStore;
	beforeEach(() => {
		store = new MemoryRateLimitStore();
	});

	it('allows the first hit and reports count=1', async () => {
		const limit = new RateLimit({ store, windowSeconds: 60, max: 3 });
		const r = await limit.check('5551');
		expect(r.allowed).toBe(true);
		expect(r.count).toBe(1);
		expect(r.retryAfter).toBe(0);
	});

	it('allows hits up to the cap', async () => {
		const limit = new RateLimit({ store, windowSeconds: 60, max: 3 });
		expect((await limit.check('5551')).allowed).toBe(true);
		expect((await limit.check('5551')).allowed).toBe(true);
		expect((await limit.check('5551')).allowed).toBe(true);
	});

	it('rejects the call that would cross the cap', async () => {
		const limit = new RateLimit({ store, windowSeconds: 60, max: 2 });
		await limit.check('5551');
		await limit.check('5551');
		const r = await limit.check('5551');
		expect(r.allowed).toBe(false);
		expect(r.count).toBe(2);
		expect(r.retryAfter).toBeGreaterThan(0);
	});

	it('does NOT persist a hit when rejecting', async () => {
		const limit = new RateLimit({ store, windowSeconds: 60, max: 1 });
		await limit.check('5551');
		await limit.check('5551'); // rejected
		await limit.check('5551'); // rejected
		expect((await store.get('5551')).length).toBe(1);
	});

	it('max = 0 rejects every call immediately', async () => {
		const limit = new RateLimit({ store, windowSeconds: 60, max: 0 });
		const r = await limit.check('5551');
		expect(r.allowed).toBe(false);
		expect(r.retryAfter).toBeGreaterThan(0);
	});

	it('keys are independent', async () => {
		const limit = new RateLimit({ store, windowSeconds: 60, max: 1 });
		expect((await limit.check('a')).allowed).toBe(true);
		expect((await limit.check('b')).allowed).toBe(true);
		expect((await limit.check('a')).allowed).toBe(false);
	});

	it('drops hits outside the window', async () => {
		const limit = new RateLimit({ store, windowSeconds: 10, max: 2 });
		const now = Math.floor(Date.now() / 1000);
		// Pre-seed two hits — one inside the window, one outside.
		await store.put('5551', [now - 100, now - 5], 60);
		const r = await limit.check('5551'); // should count only the recent one
		expect(r.allowed).toBe(true);
		expect(r.count).toBe(2); // the surviving 1 + this new hit
	});

	it('retryAfter reflects oldest hit + window', async () => {
		const limit = new RateLimit({ store, windowSeconds: 100, max: 1 });
		const now = Math.floor(Date.now() / 1000);
		await store.put('5551', [now - 30], 200);
		const r = await limit.check('5551');
		expect(r.allowed).toBe(false);
		// retryAfter ≈ window - (now - oldest) = 100 - 30 = 70
		expect(r.retryAfter).toBeGreaterThanOrEqual(69);
		expect(r.retryAfter).toBeLessThanOrEqual(71);
	});

	it('retryAfter is clamped to ≥ 1 second', async () => {
		const limit = new RateLimit({ store, windowSeconds: 1, max: 1 });
		await limit.check('5551');
		// Force a reject far enough out that retryAfter would compute as 0.
		const now = Math.floor(Date.now() / 1000);
		await store.put('5551', [now - 1], 60);
		const r = await limit.check('5551');
		expect(r.allowed).toBe(false);
		expect(r.retryAfter).toBeGreaterThanOrEqual(1);
	});

	it('fails open when the store throws', async () => {
		const throwing: RateLimitStore = {
			get: vi.fn(async () => {
				throw new Error('kv down');
			}),
			put: vi.fn(async () => {}),
		};
		const limit = new RateLimit({ store: throwing, windowSeconds: 60, max: 1 });
		const r = await limit.check('5551');
		expect(r.allowed).toBe(true);
	});
});

describe('MemoryRateLimitStore', () => {
	it('returns [] for unseen keys', async () => {
		const store = new MemoryRateLimitStore();
		expect(await store.get('x')).toEqual([]);
	});

	it('round-trips hits', async () => {
		const store = new MemoryRateLimitStore();
		await store.put('x', [1, 2, 3], 60);
		expect(await store.get('x')).toEqual([1, 2, 3]);
	});

	it('treats expired entries as absent', async () => {
		const store = new MemoryRateLimitStore();
		await store.put('x', [1], -10); // already expired
		expect(await store.get('x')).toEqual([]);
	});

	it('clear() drops all entries', async () => {
		const store = new MemoryRateLimitStore();
		await store.put('x', [1], 60);
		store.clear();
		expect(await store.get('x')).toEqual([]);
	});

	it('returned arrays are defensive copies', async () => {
		const store = new MemoryRateLimitStore();
		await store.put('x', [1, 2], 60);
		const a = await store.get('x');
		a.push(99);
		const b = await store.get('x');
		expect(b).toEqual([1, 2]);
	});
});

describe('KvRateLimitStore', () => {
	function fakeKv() {
		const map = new Map<string, string>();
		return {
			get: vi.fn(async (key: string, type?: 'json') => {
				const raw = map.get(key);
				if (!raw) return null;
				return type === 'json' ? JSON.parse(raw) : raw;
			}),
			put: vi.fn(async (key: string, value: string) => {
				map.set(key, value);
			}),
			_map: map,
		} as unknown as KVNamespace & { _map: Map<string, string> };
	}

	it('throws when kv binding is missing', () => {
		// @ts-expect-error testing
		expect(() => new KvRateLimitStore({})).toThrow();
	});

	it('namespaces keys with the configured prefix', async () => {
		const kv = fakeKv();
		const store = new KvRateLimitStore({ kv, prefix: 'rl:webhook' });
		await store.put('5551', [1, 2], 60);
		expect((kv as unknown as { _map: Map<string, string> })._map.has('rl:webhook:5551')).toBe(true);
	});

	it('returns [] when the kv entry is missing', async () => {
		const kv = fakeKv();
		const store = new KvRateLimitStore({ kv });
		expect(await store.get('nope')).toEqual([]);
	});

	it('clamps expirationTtl to ≥ 60 seconds (Workers docs minimum)', async () => {
		const kv = fakeKv();
		const store = new KvRateLimitStore({ kv });
		await store.put('5551', [1], 5);
		const putMock = kv.put as unknown as { mock: { calls: unknown[][] } };
		const opts = putMock.mock.calls[0]?.[2] as { expirationTtl: number };
		expect(opts.expirationTtl).toBe(60);
	});

	it('rounds up fractional TTLs', async () => {
		const kv = fakeKv();
		const store = new KvRateLimitStore({ kv });
		await store.put('5551', [1], 119.4);
		const putMock = kv.put as unknown as { mock: { calls: unknown[][] } };
		const opts = putMock.mock.calls[0]?.[2] as { expirationTtl: number };
		expect(opts.expirationTtl).toBe(120);
	});

	it('round-trips hits via the underlying kv', async () => {
		const kv = fakeKv();
		const store = new KvRateLimitStore({ kv });
		await store.put('5551', [1, 2, 3], 60);
		expect(await store.get('5551')).toEqual([1, 2, 3]);
	});

	it('filters out non-number entries in the persisted hits array', async () => {
		const kv = fakeKv();
		const store = new KvRateLimitStore({ kv });
		(kv as unknown as { _map: Map<string, string> })._map.set('rl:5551', JSON.stringify({ hits: [1, 'bogus', 3] }));
		expect(await store.get('5551')).toEqual([1, 3]);
	});
});

describe('honoRateLimit middleware', () => {
	function fakeCtx(overrides: Partial<HonoRateLimitContext> = {}) {
		const json = vi.fn((body: unknown, status?: number) => new Response(JSON.stringify(body), { status: status ?? 200 }));
		return {
			req: { header: () => undefined, path: '/webhook' },
			json,
			...overrides,
			_json: json,
		} as unknown as HonoRateLimitContext & { _json: ReturnType<typeof vi.fn> };
	}

	it('calls next() when under the cap', async () => {
		const limit = new RateLimit({ store: new MemoryRateLimitStore(), windowSeconds: 60, max: 5 });
		const next = vi.fn(async () => {});
		const mw = honoRateLimit(limit);
		const c = fakeCtx();
		await mw(c as never, next);
		expect(next).toHaveBeenCalledOnce();
	});

	it('returns 429 + retry_after when over the cap', async () => {
		const store = new MemoryRateLimitStore();
		const now = Math.floor(Date.now() / 1000);
		await store.put('unknown:/webhook', [now, now], 60);
		const limit = new RateLimit({ store, windowSeconds: 60, max: 2 });
		const next = vi.fn(async () => {});
		const mw = honoRateLimit(limit);
		const c = fakeCtx();
		const res = (await mw(c as never, next)) as Response;
		expect(next).not.toHaveBeenCalled();
		expect(res.status).toBe(429);
		const body = (await res.json()) as { error: string; retry_after_seconds: number };
		expect(body.error).toBe('rate_limited');
		expect(body.retry_after_seconds).toBeGreaterThan(0);
	});

	it('default key uses cf-connecting-ip + path', async () => {
		const store = new MemoryRateLimitStore();
		const limit = new RateLimit({ store, windowSeconds: 60, max: 1 });
		const mw = honoRateLimit(limit);
		const c = fakeCtx({ req: { header: (h: string) => (h === 'cf-connecting-ip' ? '1.2.3.4' : undefined), path: '/webhook' } });
		await mw(c as never, vi.fn(async () => {}));
		const hits = await store.get('1.2.3.4:/webhook');
		expect(hits.length).toBe(1);
	});

	it('honors a custom keyFn', async () => {
		const store = new MemoryRateLimitStore();
		const limit = new RateLimit({ store, windowSeconds: 60, max: 1 });
		const mw = honoRateLimit(limit, { keyFn: () => 'tenant:abc' });
		await mw(fakeCtx() as never, vi.fn(async () => {}));
		expect((await store.get('tenant:abc')).length).toBe(1);
	});

	it('honors a custom onReject', async () => {
		const store = new MemoryRateLimitStore();
		const limit = new RateLimit({ store, windowSeconds: 60, max: 0 });
		const mw = honoRateLimit(limit, { onReject: () => new Response('blocked', { status: 418 }) });
		const res = (await mw(fakeCtx() as never, vi.fn(async () => {}))) as Response;
		expect(res.status).toBe(418);
		expect(await res.text()).toBe('blocked');
	});
});
