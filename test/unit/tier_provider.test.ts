import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HttpTierProvider, StaticTierProvider } from '../../src/gate/tier_provider.js';

describe('StaticTierProvider', () => {
	it('returns the configured value for a known whatsapp', async () => {
		const p = new StaticTierProvider({ '5551': { authorized: true, tier: 'premium' } });
		expect(await p.getTier('5551')).toEqual({ authorized: true, tier: 'premium' });
	});

	it('returns the default for unknown', async () => {
		const p = new StaticTierProvider({});
		expect(await p.getTier('unknown')).toEqual({ authorized: false, tier: 'free' });
	});
});

describe('HttpTierProvider', () => {
	let originalFetch: typeof fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it('throws on missing baseUrl', () => {
		// @ts-expect-error testing
		expect(() => new HttpTierProvider({})).toThrow();
	});

	it('GETs ${baseUrl}/${whatsapp}/tier with bearer token', async () => {
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({ authorized: true, tier: 'premium' }), { status: 200 }));
		globalThis.fetch = fetchMock as typeof fetch;

		const p = new HttpTierProvider({ baseUrl: 'https://billing.x', token: 'BT' });
		const r = await p.getTier('5551');
		expect(r).toEqual({ authorized: true, tier: 'premium' });
		expect(fetchMock).toHaveBeenCalledWith('https://billing.x/5551/tier', expect.objectContaining({ method: 'GET' }));
		const firstCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit] | undefined;
		const headers = (firstCall?.[1]?.headers ?? {}) as Record<string, string>;
		expect(headers.Authorization).toBe('Bearer BT');
	});

	it('strips trailing slash from baseUrl', async () => {
		const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
		globalThis.fetch = fetchMock as typeof fetch;
		const p = new HttpTierProvider({ baseUrl: 'https://x.com/' });
		await p.getTier('5551');
		expect(fetchMock).toHaveBeenCalledWith('https://x.com/5551/tier', expect.anything());
	});

	it('uses the urlFor override when configured', async () => {
		const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
		globalThis.fetch = fetchMock as typeof fetch;
		const p = new HttpTierProvider({ baseUrl: 'https://x', urlFor: (wa) => `https://other/u/${wa}` });
		await p.getTier('5551');
		expect(fetchMock).toHaveBeenCalledWith('https://other/u/5551', expect.anything());
	});

	it('returns default tier on non-200 response', async () => {
		globalThis.fetch = vi.fn(async () => new Response('not found', { status: 404 })) as typeof fetch;
		const p = new HttpTierProvider({ baseUrl: 'https://x' });
		expect(await p.getTier('5551')).toEqual({ authorized: false, tier: 'free' });
	});

	it('returns default tier on fetch throw', async () => {
		globalThis.fetch = vi.fn(async () => {
			throw new Error('network down');
		}) as typeof fetch;
		const p = new HttpTierProvider({ baseUrl: 'https://x' });
		expect(await p.getTier('5551')).toEqual({ authorized: false, tier: 'free' });
	});

	it('caches successful responses for cacheMs window', async () => {
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({ authorized: true, tier: 'premium' }), { status: 200 }));
		globalThis.fetch = fetchMock as typeof fetch;

		const p = new HttpTierProvider({ baseUrl: 'https://x', cacheMs: 60_000 });
		await p.getTier('5551');
		await p.getTier('5551');
		await p.getTier('5551');
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it('invalidate() clears the cache', async () => {
		const fetchMock = vi.fn(async () => new Response('{"authorized":true,"tier":"premium"}', { status: 200 }));
		globalThis.fetch = fetchMock as typeof fetch;

		const p = new HttpTierProvider({ baseUrl: 'https://x' });
		await p.getTier('5551');
		p.invalidate('5551');
		await p.getTier('5551');
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('honors custom defaultTier on errors', async () => {
		globalThis.fetch = vi.fn(async () => new Response('', { status: 500 })) as typeof fetch;
		const p = new HttpTierProvider({ baseUrl: 'https://x', defaultTier: 'guest' });
		expect(await p.getTier('5551')).toEqual({ authorized: false, tier: 'guest' });
	});
});
