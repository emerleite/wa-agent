import { describe, it, expect, vi } from 'vitest';
import { OpenAIAssistant, defaultClean } from '../../src/ai/openai_assistant.js';

function makeClient(overrides: Partial<Record<string, unknown>> = {}) {
	const create = vi.fn(async () => ({ id: 'thread_new' }));
	const messagesCreate = vi.fn(async () => ({}));
	const messagesList = vi.fn(async () => ({
		data: [{ content: [{ text: { value: 'hello world' } }] }],
	}));
	const createAndPoll = vi.fn(async (tid: string) => ({ status: 'completed', thread_id: tid }));

	return {
		beta: {
			threads: {
				create,
				messages: { create: messagesCreate, list: messagesList },
				runs: { createAndPoll },
			},
		},
		_spies: { create, messagesCreate, messagesList, createAndPoll },
		...overrides,
	};
}

describe('defaultClean', () => {
	it('strips OpenAI citation markers', () => {
		expect(defaultClean('Hello【source】 world')).toBe('Hello world');
	});
	it('collapses repeated asterisks', () => {
		expect(defaultClean('**bold** and ***bolder***')).toBe('*bold* and *bolder*');
	});
	it('handles empty input', () => {
		expect(defaultClean('')).toBe('');
	});
});

describe('OpenAIAssistant', () => {
	it('throws on missing client or assistantId', () => {
		// @ts-expect-error testing
		expect(() => new OpenAIAssistant({ assistantId: 'a' })).toThrow();
		// @ts-expect-error testing
		expect(() => new OpenAIAssistant({ client: {} })).toThrow();
	});

	it('chat() with a known threadId reuses it', async () => {
		const client = makeClient();
		const a = new OpenAIAssistant({ client: client as never, assistantId: 'asst_1' });
		const r = await a.chat({ threadId: 'thread_existing', text: 'hi' });
		expect(r.threadId).toBe('thread_existing');
		expect(r.answer).toBe('hello world');
		expect(client._spies.create).not.toHaveBeenCalled();
	});

	it('chat() with null threadId creates a new thread', async () => {
		const client = makeClient();
		const a = new OpenAIAssistant({ client: client as never, assistantId: 'asst_1' });
		const r = await a.chat({ threadId: null, text: 'hi' });
		expect(client._spies.create).toHaveBeenCalledOnce();
		expect(r.threadId).toBe('thread_new');
	});

	it('chat() returns null answer when run is not completed', async () => {
		const client = makeClient();
		client._spies.createAndPoll.mockResolvedValue({ status: 'failed', thread_id: 't' });
		const a = new OpenAIAssistant({ client: client as never, assistantId: 'asst_1' });
		const r = await a.chat({ threadId: 't', text: 'hi' });
		expect(r.answer).toBeNull();
	});

	it('chat() recovers from "No thread found" by creating a fresh thread', async () => {
		const client = makeClient();
		// First create call: throws "No thread found"
		client._spies.messagesCreate.mockRejectedValueOnce(new Error('No thread found for given id'));

		const a = new OpenAIAssistant({ client: client as never, assistantId: 'asst_1' });
		const r = await a.chat({ threadId: 'invalid', text: 'hi' });

		expect(client._spies.create).toHaveBeenCalled();
		expect(r.answer).toBe('hello world');
	});

	it('cleanResult callback is applied to model output', async () => {
		const client = makeClient();
		const a = new OpenAIAssistant({
			client: client as never,
			assistantId: 'asst_1',
			cleanResult: (s) => s.toUpperCase(),
		});
		const r = await a.chat({ threadId: 't', text: 'hi' });
		expect(r.answer).toBe('HELLO WORLD');
	});
});
