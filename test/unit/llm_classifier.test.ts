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
});
