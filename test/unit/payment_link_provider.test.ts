import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HttpPaymentLinkProvider, expandTokens } from '../../src/gate/payment_link_provider.js';

describe('HttpPaymentLinkProvider', () => {
	let originalFetch: typeof fetch;
	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it('throws on missing baseUrl', () => {
		// @ts-expect-error testing
		expect(() => new HttpPaymentLinkProvider({})).toThrow();
	});

	it('POSTs ${baseUrl}/${whatsapp}/payment_link with bearer', async () => {
		const fetchMock = vi.fn(async () =>
			new Response(JSON.stringify({ payment_link: 'https://pay.x/abc' }), { status: 200 })
		);
		globalThis.fetch = fetchMock as typeof fetch;

		const p = new HttpPaymentLinkProvider({ baseUrl: 'https://billing.x', token: 'BT' });
		const r = await p.getPaymentLink({ whatsapp: '5551', name: 'Ada' });
		expect(r).toBe('https://pay.x/abc');
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('https://billing.x/5551/payment_link');
		expect(init.method).toBe('POST');
		const headers = (init.headers ?? {}) as Record<string, string>;
		expect(headers.Authorization).toBe('Bearer BT');
		expect(JSON.parse(String(init.body))).toEqual({ name: 'Ada', campaign: null });
	});

	it('returns null on non-200', async () => {
		globalThis.fetch = vi.fn(async () => new Response('not found', { status: 404 })) as typeof fetch;
		const p = new HttpPaymentLinkProvider({ baseUrl: 'https://x' });
		expect(await p.getPaymentLink({ whatsapp: '5551' })).toBeNull();
	});

	it('returns null on fetch throw', async () => {
		globalThis.fetch = vi.fn(async () => {
			throw new Error('network down');
		}) as typeof fetch;
		const p = new HttpPaymentLinkProvider({ baseUrl: 'https://x' });
		expect(await p.getPaymentLink({ whatsapp: '5551' })).toBeNull();
	});

	it('caches successful + null results for cacheMs', async () => {
		const fetchMock = vi.fn(async () =>
			new Response(JSON.stringify({ payment_link: 'https://pay.x/abc' }), { status: 200 })
		);
		globalThis.fetch = fetchMock as typeof fetch;
		const p = new HttpPaymentLinkProvider({ baseUrl: 'https://x', cacheMs: 60_000 });
		await p.getPaymentLink({ whatsapp: '5551' });
		await p.getPaymentLink({ whatsapp: '5551' });
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it('invalidate() clears the cache', async () => {
		const fetchMock = vi.fn(async () =>
			new Response(JSON.stringify({ payment_link: 'https://pay.x/abc' }), { status: 200 })
		);
		globalThis.fetch = fetchMock as typeof fetch;
		const p = new HttpPaymentLinkProvider({ baseUrl: 'https://x' });
		await p.getPaymentLink({ whatsapp: '5551' });
		p.invalidate('5551');
		await p.getPaymentLink({ whatsapp: '5551' });
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('honors custom urlFor + extract', async () => {
		const fetchMock = vi.fn(async () =>
			new Response(JSON.stringify({ data: { url: 'https://pay.x/y' } }), { status: 200 })
		);
		globalThis.fetch = fetchMock as typeof fetch;
		const p = new HttpPaymentLinkProvider({
			baseUrl: 'https://x',
			urlFor: (wa) => `https://other/p/${wa}`,
			extract: (d) => (d as { data?: { url?: string } })?.data?.url ?? null,
		});
		expect(await p.getPaymentLink({ whatsapp: '5551' })).toBe('https://pay.x/y');
		expect(fetchMock).toHaveBeenCalledWith('https://other/p/5551', expect.anything());
	});
});

describe('expandTokens', () => {
	it('substitutes a single string token', async () => {
		const out = await expandTokens('Pay here: {{link}}', { '{{link}}': 'https://pay.x/a' });
		expect(out).toBe('Pay here: https://pay.x/a');
	});

	it('substitutes a function-resolved token', async () => {
		const out = await expandTokens('Pay here: {{link}}', { '{{link}}': () => 'https://pay.x/b' });
		expect(out).toBe('Pay here: https://pay.x/b');
	});

	it('supports async resolvers', async () => {
		const out = await expandTokens('Pay here: {{link}}', { '{{link}}': async () => 'https://pay.x/c' });
		expect(out).toBe('Pay here: https://pay.x/c');
	});

	it('does not call resolvers whose token is absent', async () => {
		const resolver = vi.fn(() => 'never');
		await expandTokens('no tokens here', { '{{link}}': resolver });
		expect(resolver).not.toHaveBeenCalled();
	});

	it('leaves placeholder intact when resolver returns null', async () => {
		const out = await expandTokens('Pay here: {{link}}', { '{{link}}': () => null });
		expect(out).toBe('Pay here: {{link}}');
	});

	it('replaces every occurrence', async () => {
		const out = await expandTokens('{{x}} and {{x}}', { '{{x}}': 'y' });
		expect(out).toBe('y and y');
	});
});
