import { describe, it, expect, vi } from 'vitest';
import { Transcriber } from '../../src/ai/transcriber.js';

function makeClient(text: string | null = 'transcribed text') {
	const create = vi.fn(async () => ({ text }));
	return { audio: { transcriptions: { create } }, _create: create };
}

describe('Transcriber', () => {
	it('throws on missing client', () => {
		// @ts-expect-error testing
		expect(() => new Transcriber({})).toThrow();
	});

	it('returns null for null audioStream', async () => {
		const client = makeClient();
		const t = new Transcriber({ client: client as never });
		expect(await t.transcribe(null)).toBeNull();
	});

	it('returns null when API result has no text', async () => {
		const client = makeClient(null);
		const t = new Transcriber({ client: client as never });
		const stream = new ReadableStream({ start: (c) => c.close() });
		const result = await t.transcribe(stream);
		// Either null (toFile failed) or null (no text) — both acceptable
		expect(result).toBeNull();
	});

	it('returns null on API error (does not throw)', async () => {
		const client = {
			audio: { transcriptions: { create: vi.fn(async () => { throw new Error('rate limit'); }) } },
		};
		const t = new Transcriber({ client: client as never });
		const stream = new ReadableStream({ start: (c) => c.close() });
		await expect(t.transcribe(stream)).resolves.toBeNull();
	});

	it('returns the transcribed text on success', async () => {
		const client = makeClient('hello there');
		const t = new Transcriber({ client: client as never });
		const stream = new ReadableStream({ start: (c) => c.close() });
		expect(await t.transcribe(stream)).toBe('hello there');
	});

	it('forwards the configured model to the API call', async () => {
		const client = makeClient('x');
		const t = new Transcriber({ client: client as never, model: 'whisper-large-v3' });
		const stream = new ReadableStream({ start: (c) => c.close() });
		await t.transcribe(stream);
		const calls = client._create.mock.calls as unknown as Array<[{ model: string; file: unknown }]>;
		expect(calls[0]?.[0]?.model).toBe('whisper-large-v3');
	});

	it('defaults to whisper-1 model when none configured', async () => {
		const client = makeClient('x');
		const t = new Transcriber({ client: client as never });
		const stream = new ReadableStream({ start: (c) => c.close() });
		await t.transcribe(stream);
		const calls = client._create.mock.calls as unknown as Array<[{ model: string }]>;
		expect(calls[0]?.[0]?.model).toBe('whisper-1');
	});

	it('returns null when API returns empty-string text (treats falsy as missing)', async () => {
		const client = makeClient('');
		const t = new Transcriber({ client: client as never });
		const stream = new ReadableStream({ start: (c) => c.close() });
		expect(await t.transcribe(stream)).toBeNull();
	});

	it('does not call the API when audioStream is null', async () => {
		const client = makeClient('x');
		const t = new Transcriber({ client: client as never });
		await t.transcribe(null);
		expect(client._create).not.toHaveBeenCalled();
	});
});
