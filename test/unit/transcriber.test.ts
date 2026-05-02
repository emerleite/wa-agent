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
});
