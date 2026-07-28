import { describe, it, expect, vi } from 'vitest';
import { ingestMedia, type MediaStorage } from '../../src/media/media_pipeline.js';

function fakeClient(dl: { stream: ReadableStream; mimeType?: string; sha256?: string; fileSize?: number } | null) {
	return {
		downloadMediaWithMeta: vi.fn(async () => dl),
	};
}

function fakeStorage(): MediaStorage & { calls: unknown[] } {
	const calls: unknown[] = [];
	return {
		calls,
		async upload(args) {
			calls.push(args);
			return { key: `${args.scope}/${args.id}`, url: `https://cdn.example/${args.scope}/${args.id}` };
		},
	};
}

function textStream(text: string): ReadableStream {
	return new Response(text).body!;
}

describe('ingestMedia', () => {
	it('downloads then uploads with Meta-provided mimeType', async () => {
		const client = fakeClient({
			stream: textStream('body-bytes'),
			mimeType: 'image/jpeg',
			sha256: 'abc',
			fileSize: 42,
		});
		const store = fakeStorage();
		const r = await ingestMedia({ client, mediaId: 'MID1', store, scope: '5511', id: 'wamid.a' });
		expect(client.downloadMediaWithMeta).toHaveBeenCalledWith('MID1');
		expect(r).toEqual({
			key: '5511/wamid.a',
			url: 'https://cdn.example/5511/wamid.a',
			mimeType: 'image/jpeg',
			sha256: 'abc',
			fileSize: 42,
		});
		expect(store.calls[0]).toMatchObject({ scope: '5511', id: 'wamid.a', contentType: 'image/jpeg' });
	});

	it('applies defaultContentType when Meta returned none', async () => {
		const client = fakeClient({ stream: textStream('x') });
		const store = fakeStorage();
		await ingestMedia({ client, mediaId: 'M', store, scope: 's', id: 'i', defaultContentType: 'audio/opus' });
		expect(store.calls[0]).toMatchObject({ contentType: 'audio/opus' });
	});

	it('throws when Meta returns nothing', async () => {
		const client = fakeClient(null);
		const store = fakeStorage();
		await expect(ingestMedia({ client, mediaId: 'MISSING', store, scope: 's', id: 'i' })).rejects.toThrow(/no bytes/);
	});

	it('forwards metadata to store.upload', async () => {
		const client = fakeClient({ stream: textStream('x'), mimeType: 'image/png' });
		const store = fakeStorage();
		await ingestMedia({ client, mediaId: 'M', store, scope: 's', id: 'i', metadata: { source: 'inbound' } });
		expect(store.calls[0]).toMatchObject({ metadata: { source: 'inbound' } });
	});
});
