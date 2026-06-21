import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OpenAICompatProvider, WorkersAIProvider, type WorkersAIBinding } from '../../src/ai/llm_provider.js';

beforeEach(() => {
	vi.restoreAllMocks();
});

function mockFetch(impl: Parameters<typeof vi.fn>[0]) {
	vi.stubGlobal('fetch', vi.fn(impl));
}

describe('OpenAICompatProvider — construction', () => {
	it('throws when name / url / model missing', () => {
		expect(() => new OpenAICompatProvider({ name: '', url: 'u', apiKey: 'k', model: 'm' })).toThrow();
		expect(() => new OpenAICompatProvider({ name: 'n', url: '', apiKey: 'k', model: 'm' })).toThrow();
		expect(() => new OpenAICompatProvider({ name: 'n', url: 'u', apiKey: 'k', model: '' })).toThrow();
	});
});

describe('OpenAICompatProvider — success path', () => {
	it('returns ok with tokens + model when API returns 200', async () => {
		mockFetch(async () => new Response(
			JSON.stringify({
				choices: [{ message: { content: 'hello world' } }],
				usage: { prompt_tokens: 10, completion_tokens: 5 },
			}),
			{ status: 200, headers: { 'content-type': 'application/json' } },
		));
		const p = new OpenAICompatProvider({ name: 'test', url: 'https://x/y', apiKey: 'k', model: 'm-1' });
		const r = await p.run({ system: 's', user: 'u' });
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.response).toBe('hello world');
			expect(r.tokensIn).toBe(10);
			expect(r.tokensOut).toBe(5);
			expect(r.model).toBe('m-1');
			expect(r.httpStatus).toBe(200);
		}
	});

	it('sends Bearer + JSON body + extraHeaders + extraBody', async () => {
		const fetchSpy = vi.fn(async () => new Response(
			JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
			{ status: 200, headers: { 'content-type': 'application/json' } },
		));
		vi.stubGlobal('fetch', fetchSpy);
		const p = new OpenAICompatProvider({
			name: 'or',
			url: 'https://or/api',
			apiKey: 'secret',
			model: 'm',
			extraHeaders: { 'HTTP-Referer': 'https://app.example' },
			extraBody: { stream: false },
		});
		await p.run({ system: 's', user: 'u' });
		const call = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
		expect(call[0]).toBe('https://or/api');
		expect(call[1].headers).toMatchObject({
			Authorization: 'Bearer secret',
			'HTTP-Referer': 'https://app.example',
		});
		const body = JSON.parse(call[1].body as string);
		expect(body).toMatchObject({ model: 'm', stream: false });
		expect(body.messages).toEqual([
			{ role: 'system', content: 's' },
			{ role: 'user', content: 'u' },
		]);
	});
});

describe('OpenAICompatProvider — failure classification', () => {
	it('classifies 429 → errorKind 429', async () => {
		mockFetch(async () => new Response(JSON.stringify({ error: 'too many' }), { status: 429 }));
		const p = new OpenAICompatProvider({ name: 'n', url: 'u', apiKey: 'k', model: 'm' });
		const r = await p.run({ system: 's', user: 'u' });
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.errorKind).toBe('429');
			expect(r.httpStatus).toBe(429);
		}
	});

	it('classifies 500+ → errorKind 5xx', async () => {
		mockFetch(async () => new Response(JSON.stringify({ error: 'boom' }), { status: 503 }));
		const p = new OpenAICompatProvider({ name: 'n', url: 'u', apiKey: 'k', model: 'm' });
		const r = await p.run({ system: 's', user: 'u' });
		if (!r.ok) expect(r.errorKind).toBe('5xx');
	});

	it('classifies 4xx (non-429) → errorKind 5xx (treated as serverError bucket)', async () => {
		mockFetch(async () => new Response(JSON.stringify({ error: 'bad key' }), { status: 401 }));
		const p = new OpenAICompatProvider({ name: 'n', url: 'u', apiKey: 'k', model: 'm' });
		const r = await p.run({ system: 's', user: 'u' });
		if (!r.ok) expect(r.errorKind).toBe('5xx');
	});

	it('malformed JSON → errorKind parse', async () => {
		mockFetch(async () => new Response('not-json', { status: 200, headers: { 'content-type': 'text/plain' } }));
		const p = new OpenAICompatProvider({ name: 'n', url: 'u', apiKey: 'k', model: 'm' });
		const r = await p.run({ system: 's', user: 'u' });
		if (!r.ok) expect(r.errorKind).toBe('parse');
	});

	it('missing content → errorKind parse', async () => {
		mockFetch(async () => new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), { status: 200 }));
		const p = new OpenAICompatProvider({ name: 'n', url: 'u', apiKey: 'k', model: 'm' });
		const r = await p.run({ system: 's', user: 'u' });
		if (!r.ok) expect(r.errorKind).toBe('parse');
	});

	it('AbortController fires on timeout → errorKind timeout', async () => {
		mockFetch(async (_url: unknown, init?: RequestInit) => {
			// Honor abort signal — vitest can't fast-forward fetch reliably, so
			// resolve when the signal fires.
			return await new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () => {
					reject(new DOMException('aborted', 'AbortError'));
				});
			});
		});
		const p = new OpenAICompatProvider({ name: 'n', url: 'u', apiKey: 'k', model: 'm' });
		const r = await p.run({ system: 's', user: 'u', timeoutMs: 20 });
		if (!r.ok) expect(r.errorKind).toBe('timeout');
	});

	it('apiKey missing → errorKind config (no fetch attempted)', async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		const p = new OpenAICompatProvider({ name: 'n', url: 'u', apiKey: '', model: 'm' });
		const r = await p.run({ system: 's', user: 'u' });
		expect(fetchSpy).not.toHaveBeenCalled();
		if (!r.ok) expect(r.errorKind).toBe('config');
	});
});

describe('WorkersAIProvider', () => {
	function fakeBinding(impl: WorkersAIBinding['run']): WorkersAIBinding {
		return { run: impl };
	}

	it('returns ok with response from env.AI.run', async () => {
		const p = new WorkersAIProvider({
			name: 'wai',
			ai: fakeBinding(async () => ({ response: 'hi', usage: { prompt_tokens: 3, completion_tokens: 1 } })),
			model: '@cf/meta/llama',
		});
		const r = await p.run({ system: 's', user: 'u' });
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.response).toBe('hi');
			expect(r.tokensIn).toBe(3);
			expect(r.tokensOut).toBe(1);
		}
	});

	it('missing binding → errorKind config', async () => {
		const p = new WorkersAIProvider({ name: 'wai', ai: undefined, model: 'm' });
		const r = await p.run({ system: 's', user: 'u' });
		if (!r.ok) expect(r.errorKind).toBe('config');
	});

	it('rate-limit-looking exception → errorKind 429', async () => {
		const p = new WorkersAIProvider({
			name: 'wai',
			ai: fakeBinding(async () => {
				throw new Error('rate limited: too many requests');
			}),
			model: 'm',
		});
		const r = await p.run({ system: 's', user: 'u' });
		if (!r.ok) expect(r.errorKind).toBe('429');
	});

	it('generic exception → errorKind network', async () => {
		const p = new WorkersAIProvider({
			name: 'wai',
			ai: fakeBinding(async () => {
				throw new Error('something failed');
			}),
			model: 'm',
		});
		const r = await p.run({ system: 's', user: 'u' });
		if (!r.ok) expect(r.errorKind).toBe('network');
	});

	it('empty response → errorKind parse', async () => {
		const p = new WorkersAIProvider({
			name: 'wai',
			ai: fakeBinding(async () => ({ response: '' })),
			model: 'm',
		});
		const r = await p.run({ system: 's', user: 'u' });
		if (!r.ok) expect(r.errorKind).toBe('parse');
	});
});
