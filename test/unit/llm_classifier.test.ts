import { describe, it, expect, vi } from 'vitest';
import { LLMClassifier } from '../../src/ai/llm_classifier.js';
import type { AIRouter } from '../../src/ai/router.js';

function stubRouter(reply: unknown): AIRouter {
	return { route: vi.fn(async () => reply) } as unknown as AIRouter;
}

describe('LLMClassifier', () => {
	const cats = ['pastoral', 'duvida', 'conversa', 'other'] as const;

	it('parses strict JSON with categoria field', async () => {
		const router = stubRouter({ ok: true, response: '{"categoria":"pastoral"}', provider: 'groq_70b' });
		const c = new LLMClassifier({ router, chainName: 'cls', systemPrompt: '...', categories: cats, fallback: 'other' });
		const r = await c.classify('quero uma oração');
		expect(r.category).toBe('pastoral');
		expect(r.confident).toBe(true);
		expect(r.provider).toBe('groq_70b');
	});

	it('accepts English `category` key too', async () => {
		const router = stubRouter({ ok: true, response: '{"category":"duvida"}', provider: 'x' });
		const c = new LLMClassifier({ router, chainName: 'cls', systemPrompt: '...', categories: cats, fallback: 'other' });
		expect((await c.classify('...')).category).toBe('duvida');
	});

	it('falls back to fallback when router failed', async () => {
		const router = stubRouter({ ok: false, errorKind: 'all_failed', errorMessage: 'nothing worked' });
		const c = new LLMClassifier({ router, chainName: 'cls', systemPrompt: '...', categories: cats, fallback: 'other' });
		const r = await c.classify('...');
		expect(r.category).toBe('other');
		expect(r.confident).toBe(false);
		expect(r.routerError).toContain('nothing');
	});

	it('falls back when response is unparseable', async () => {
		const router = stubRouter({ ok: true, response: 'i disagree with your premise', provider: 'x' });
		const c = new LLMClassifier({ router, chainName: 'cls', systemPrompt: '...', categories: cats, fallback: 'other' });
		const r = await c.classify('...');
		expect(r.category).toBe('other');
		expect(r.confident).toBe(false);
		expect(r.parseError).toBe(true);
		expect(r.raw).toContain('disagree');
	});

	it('falls back when parsed value is outside allowed categories', async () => {
		const router = stubRouter({ ok: true, response: '{"categoria":"random_thing"}', provider: 'x' });
		const c = new LLMClassifier({ router, chainName: 'cls', systemPrompt: '...', categories: cats, fallback: 'other' });
		const r = await c.classify('...');
		expect(r.category).toBe('other');
		expect(r.confident).toBe(false);
		expect(r.parseError).toBe(true);
	});

	it('extracts categoria from loose regex when JSON is broken', async () => {
		const router = stubRouter({ ok: true, response: 'Here you go: "categoria": "pastoral", have a great day', provider: 'x' });
		const c = new LLMClassifier({ router, chainName: 'cls', systemPrompt: '...', categories: cats, fallback: 'other' });
		expect((await c.classify('...')).category).toBe('pastoral');
	});

	it('rejects fallback that is not in categories at construction time', () => {
		expect(() => new LLMClassifier({ router: stubRouter({}), chainName: 'cls', systemPrompt: '.', categories: cats, fallback: 'nope' as never })).toThrow(/fallback/);
	});

	it('honors custom userTemplate + custom parse', async () => {
		const router = stubRouter({ ok: true, response: 'PASTORAL', provider: 'x' });
		const c = new LLMClassifier({
			router,
			chainName: 'cls',
			systemPrompt: '.',
			categories: cats,
			fallback: 'other',
			userTemplate: (t) => `MSG:${t}`,
			parse: (raw) => raw.trim().toLowerCase(),
		});
		expect((await c.classify('hi')).category).toBe('pastoral');
	});

	it('defaults: userTemplate wraps in <msg>...</msg>, maxTokens=24, temperature=0', async () => {
		const calls: Array<{ chain: string; args: Record<string, unknown> }> = [];
		const routeFn = vi.fn(async (chain: string, args: Record<string, unknown>) => {
			calls.push({ chain, args });
			return { ok: true, response: '{"categoria":"other"}', provider: 'x' };
		});
		const router = { route: routeFn } as unknown as AIRouter;
		const c = new LLMClassifier({ router, chainName: 'cls', systemPrompt: 'S', categories: cats, fallback: 'other' });
		await c.classify('hi');
		const { chain, args } = calls[0]!;
		expect(chain).toBe('cls');
		expect(args.system).toBe('S');
		expect(args.user).toBe('<msg>hi</msg>');
		expect(args.maxTokens).toBe(24);
		expect(args.temperature).toBe(0);
		expect(args.whatsapp).toBeNull();
		expect(args.tenantId).toBeNull();
	});

	it('forwards custom maxTokens + temperature + whatsapp + tenantId', async () => {
		const calls: Array<{ args: Record<string, unknown> }> = [];
		const routeFn = vi.fn(async (_chain: string, args: Record<string, unknown>) => {
			calls.push({ args });
			return { ok: true, response: '{"categoria":"other"}', provider: 'x' };
		});
		const router = { route: routeFn } as unknown as AIRouter;
		const c = new LLMClassifier({
			router,
			chainName: 'cls',
			systemPrompt: 'S',
			categories: cats,
			fallback: 'other',
			maxTokens: 42,
			temperature: 0.5,
		});
		await c.classify('hi', { whatsapp: '5511', tenantId: 't1' });
		const { args } = calls[0]!;
		expect(args.maxTokens).toBe(42);
		expect(args.temperature).toBe(0.5);
		expect(args.whatsapp).toBe('5511');
		expect(args.tenantId).toBe('t1');
	});

	it('routerError falls back from errorMessage to errorKind when message is empty', async () => {
		const c = new LLMClassifier({ router: stubRouter({ ok: false, errorMessage: '', errorKind: 'timeout' }), chainName: 'cls', systemPrompt: '.', categories: cats, fallback: 'other' });
		const r = await c.classify('x');
		expect(r.routerError).toBe('timeout');
	});

	it('routerError uses errorMessage when it is truthy', async () => {
		const c = new LLMClassifier({ router: stubRouter({ ok: false, errorMessage: 'blew up', errorKind: 'network' }), chainName: 'cls', systemPrompt: '.', categories: cats, fallback: 'other' });
		expect((await c.classify('x')).routerError).toBe('blew up');
	});

	it('treats empty categoria string as parse failure (not a valid category)', async () => {
		const router = stubRouter({ ok: true, response: '{"categoria":""}', provider: 'x' });
		const c = new LLMClassifier({ router, chainName: 'cls', systemPrompt: '.', categories: cats, fallback: 'other' });
		const r = await c.classify('x');
		expect(r.category).toBe('other');
		expect(r.parseError).toBe(true);
	});

	it('matches category case-insensitively (LLM returns uppercase, categories are lowercase)', async () => {
		const router = stubRouter({ ok: true, response: '{"categoria":"PASTORAL"}', provider: 'x' });
		const c = new LLMClassifier({ router, chainName: 'cls', systemPrompt: '.', categories: cats, fallback: 'other' });
		const r = await c.classify('x');
		expect(r.category).toBe('pastoral');
		expect(r.confident).toBe(true);
	});

	it('populates raw on both success and parse-failure paths', async () => {
		const ok = await new LLMClassifier({ router: stubRouter({ ok: true, response: '{"categoria":"duvida"}', provider: 'x' }), chainName: 'cls', systemPrompt: '.', categories: cats, fallback: 'other' }).classify('x');
		expect(ok.raw).toBe('{"categoria":"duvida"}');

		const bad = await new LLMClassifier({ router: stubRouter({ ok: true, response: 'not-parseable', provider: 'x' }), chainName: 'cls', systemPrompt: '.', categories: cats, fallback: 'other' }).classify('x');
		expect(bad.raw).toBe('not-parseable');
	});

	it('populates provider only on the confident-success path', async () => {
		const r = await new LLMClassifier({ router: stubRouter({ ok: true, response: '{"categoria":"other"}', provider: 'groq_70b' }), chainName: 'cls', systemPrompt: '.', categories: cats, fallback: 'other' }).classify('x');
		expect(r.provider).toBe('groq_70b');
	});

	it('rejects missing router / chainName / categories at construction', () => {
		// @ts-expect-error missing router
		expect(() => new LLMClassifier({ chainName: 'x', systemPrompt: '.', categories: cats, fallback: 'other' })).toThrow(/router/);
		// @ts-expect-error missing chainName
		expect(() => new LLMClassifier({ router: stubRouter({}), systemPrompt: '.', categories: cats, fallback: 'other' })).toThrow(/chainName/);
		expect(() => new LLMClassifier({ router: stubRouter({}), chainName: 'x', systemPrompt: '.', categories: [], fallback: 'other' as never })).toThrow(/categories/);
	});
});
