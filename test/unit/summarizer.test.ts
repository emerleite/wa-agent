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

	it('defaults model to gpt-4o-mini and max_tokens to 1500', async () => {
		const client = makeClient();
		const s = new Summarizer({ client: client as never });
		await s.summarize('x');
		expect(client._create).toHaveBeenCalledWith(
			expect.objectContaining({ model: 'gpt-4o-mini', max_tokens: 1500 })
		);
	});

	it('default system prompt references the word-cap rule', async () => {
		const client = makeClient();
		const s = new Summarizer({ client: client as never });
		await s.summarize('x');
		const calls = client._create.mock.calls as unknown as Array<[{ messages: Array<{ role: string; content: string }> }]>;
		const args = calls[0]?.[0] as { messages: Array<{ role: string; content: string }> };
		expect(args.messages[0]?.role).toBe('system');
		expect(args.messages[0]?.content).toMatch(/225 words/);
	});

	it('custom systemPrompt is forwarded as the system message', async () => {
		const client = makeClient();
		const s = new Summarizer({ client: client as never, systemPrompt: 'be brief' });
		await s.summarize('x');
		const calls = client._create.mock.calls as unknown as Array<[{ messages: Array<{ role: string; content: string }> }]>;
		const args = calls[0]?.[0] as { messages: Array<{ role: string; content: string }> };
		expect(args.messages[0]).toEqual({ role: 'system', content: 'be brief' });
	});

	it('passes the input text as the user message after the system message', async () => {
		const client = makeClient();
		const s = new Summarizer({ client: client as never });
		await s.summarize('the long text');
		const calls = client._create.mock.calls as unknown as Array<[{ messages: Array<{ role: string; content: string }> }]>;
		const args = calls[0]?.[0] as { messages: Array<{ role: string; content: string }> };
		expect(args.messages.length).toBe(2);
		expect(args.messages[1]).toEqual({ role: 'user', content: 'the long text' });
	});

	it('returns null when choices array is empty', async () => {
		const client = {
			chat: { completions: { create: vi.fn(async () => ({ choices: [] })) } },
		};
		const s = new Summarizer({ client: client as never });
		expect(await s.summarize('x')).toBeNull();
	});

	it('returns null when the entire response shape is missing', async () => {
		const client = {
			chat: { completions: { create: vi.fn(async () => ({})) } },
		};
		const s = new Summarizer({ client: client as never });
		expect(await s.summarize('x')).toBeNull();
	});
});
