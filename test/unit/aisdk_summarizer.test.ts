import { describe, it, expect, vi } from 'vitest';

// The `ai` package's `generateText` is what AISDKSummarizer calls. We mock it
// at the module boundary so the test doesn't need a real LLM.
vi.mock('ai', () => ({
	generateText: vi.fn(async ({ system, prompt }: { system?: string; prompt?: string }) => ({
		text: `[summary of ${prompt}] sys=${system?.slice(0, 20)}`,
	})),
}));

import { AISDKSummarizer } from '../../src/ai_sdk/summarizer.js';
import { generateText } from 'ai';

const fakeModel = { specificationVersion: 'v3', provider: 'test', modelId: 'test' } as unknown as import('ai').LanguageModel;

describe('AISDKSummarizer', () => {
	it('rejects missing model at construction', () => {
		// @ts-expect-error missing model
		expect(() => new AISDKSummarizer({})).toThrow(/model required/);
	});

	it('returns null on empty / whitespace input without calling the model', async () => {
		const s = new AISDKSummarizer({ model: fakeModel });
		expect(await s.summarize('')).toBeNull();
		expect(await s.summarize('   ')).toBeNull();
		expect(generateText).not.toHaveBeenCalled();
	});

	it('calls generateText with defaults and returns the trimmed text', async () => {
		vi.mocked(generateText).mockClear();
		const s = new AISDKSummarizer({ model: fakeModel });
		const out = await s.summarize('a long message about apples');
		expect(out).toContain('[summary of a long message about apples]');
		const call = vi.mocked(generateText).mock.calls[0]![0] as Record<string, unknown>;
		expect(call.model).toBe(fakeModel);
		expect(call.maxOutputTokens).toBe(400);
		expect(call.temperature).toBe(0.3);
		expect(typeof call.system).toBe('string');
	});

	it('honors custom systemPrompt / maxOutputTokens / temperature', async () => {
		vi.mocked(generateText).mockClear();
		const s = new AISDKSummarizer({
			model: fakeModel,
			systemPrompt: 'You are a squirrel translator.',
			maxOutputTokens: 128,
			temperature: 0.9,
		});
		await s.summarize('hi');
		const call = vi.mocked(generateText).mock.calls[0]![0] as Record<string, unknown>;
		expect(call.system).toBe('You are a squirrel translator.');
		expect(call.maxOutputTokens).toBe(128);
		expect(call.temperature).toBe(0.9);
	});

	it('returns null when generateText throws (fail-soft)', async () => {
		vi.mocked(generateText).mockRejectedValueOnce(new Error('provider down'));
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const s = new AISDKSummarizer({ model: fakeModel });
		expect(await s.summarize('hi')).toBeNull();
		expect(spy).toHaveBeenCalled();
		spy.mockRestore();
	});

	it('returns null when generateText returns empty text', async () => {
		vi.mocked(generateText).mockResolvedValueOnce({ text: '   ' } as never);
		const s = new AISDKSummarizer({ model: fakeModel });
		expect(await s.summarize('hi')).toBeNull();
	});
});
