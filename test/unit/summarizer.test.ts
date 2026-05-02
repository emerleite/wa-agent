import { describe, it, expect, vi } from 'vitest';
import { Summarizer } from '../../src/ai/summarizer.js';

function makeClient(content: string | null = 'short version') {
	const create = vi.fn(async () => ({ choices: [{ message: { content } }] }));
	return { chat: { completions: { create } }, _create: create };
}

describe('Summarizer', () => {
	it('throws on missing client', () => {
		// @ts-expect-error testing
		expect(() => new Summarizer({})).toThrow();
	});

	it('returns the content from the first choice', async () => {
		const client = makeClient('summary out');
		const s = new Summarizer({ client: client as never });
		expect(await s.summarize('long text')).toBe('summary out');
	});

	it('uses configured model + maxTokens', async () => {
		const client = makeClient();
		const s = new Summarizer({ client: client as never, model: 'custom-model', maxTokens: 500 });
		await s.summarize('x');
		expect(client._create).toHaveBeenCalledWith(
			expect.objectContaining({ model: 'custom-model', max_tokens: 500 })
		);
	});

	it('returns null when content is missing', async () => {
		const client = makeClient(null);
		const s = new Summarizer({ client: client as never });
		expect(await s.summarize('x')).toBeNull();
	});

	it('returns null on API error (does not throw)', async () => {
		const client = {
			chat: { completions: { create: vi.fn(async () => { throw new Error('rate limit'); }) } },
		};
		const s = new Summarizer({ client: client as never });
		expect(await s.summarize('x')).toBeNull();
	});
});
