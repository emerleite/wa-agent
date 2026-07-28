import { describe, it, expect, vi } from 'vitest';

vi.mock('ai', () => ({
	experimental_transcribe: vi.fn(async () => ({ text: '   hello world  ' })),
}));

import { AISDKTranscriber } from '../../src/ai_sdk/transcriber.js';
import { experimental_transcribe as transcribe } from 'ai';

const fakeModel = { specificationVersion: 'v3' } as unknown as import('ai').TranscriptionModel;

describe('AISDKTranscriber', () => {
	it('rejects missing model at construction', () => {
		// @ts-expect-error missing model
		expect(() => new AISDKTranscriber({})).toThrow(/model required/);
	});

	it('returns null when audio is null / undefined', async () => {
		const t = new AISDKTranscriber({ model: fakeModel });
		expect(await t.transcribe(null)).toBeNull();
	});

	it('accepts Uint8Array and returns the trimmed text', async () => {
		vi.mocked(transcribe).mockClear();
		const t = new AISDKTranscriber({ model: fakeModel });
		const out = await t.transcribe(new Uint8Array([1, 2, 3]));
		expect(out).toBe('hello world');
		const call = vi.mocked(transcribe).mock.calls[0]![0] as Record<string, unknown>;
		expect(call.audio).toBeInstanceOf(Uint8Array);
		expect((call.audio as Uint8Array).length).toBe(3);
	});

	it('accepts ArrayBuffer', async () => {
		vi.mocked(transcribe).mockClear();
		const t = new AISDKTranscriber({ model: fakeModel });
		await t.transcribe(new ArrayBuffer(2));
		expect(vi.mocked(transcribe)).toHaveBeenCalledOnce();
	});

	it('accepts ReadableStream by draining to Uint8Array', async () => {
		vi.mocked(transcribe).mockClear();
		const stream = new Response('audio-bytes').body!;
		const t = new AISDKTranscriber({ model: fakeModel });
		await t.transcribe(stream);
		const call = vi.mocked(transcribe).mock.calls[0]![0] as Record<string, unknown>;
		expect((call.audio as Uint8Array).length).toBeGreaterThan(0);
	});

	it('returns null on empty Uint8Array', async () => {
		vi.mocked(transcribe).mockClear();
		const t = new AISDKTranscriber({ model: fakeModel });
		expect(await t.transcribe(new Uint8Array(0))).toBeNull();
		expect(transcribe).not.toHaveBeenCalled();
	});

	it('forwards providerOptions when configured', async () => {
		vi.mocked(transcribe).mockClear();
		const t = new AISDKTranscriber({
			model: fakeModel,
			providerOptions: { openai: { language: 'pt' } },
		});
		await t.transcribe(new Uint8Array([1]));
		const call = vi.mocked(transcribe).mock.calls[0]![0] as Record<string, unknown>;
		expect(call.providerOptions).toEqual({ openai: { language: 'pt' } });
	});

	it('returns null on provider error (fail-soft)', async () => {
		vi.mocked(transcribe).mockRejectedValueOnce(new Error('nope'));
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const t = new AISDKTranscriber({ model: fakeModel });
		expect(await t.transcribe(new Uint8Array([1]))).toBeNull();
		expect(spy).toHaveBeenCalled();
		spy.mockRestore();
	});

	it('returns null when transcribe returns empty text', async () => {
		vi.mocked(transcribe).mockResolvedValueOnce({ text: '' } as never);
		const t = new AISDKTranscriber({ model: fakeModel });
		expect(await t.transcribe(new Uint8Array([1]))).toBeNull();
	});
});
