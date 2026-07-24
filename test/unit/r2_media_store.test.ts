import { describe, it, expect, vi } from 'vitest';
import { R2MediaStore } from '../../src/media/r2_media_store.js';

function fakeBucket() {
	const store = new Map<string, { body: unknown; contentType: string; metadata?: Record<string, string> }>();
	return {
		store,
		put: vi.fn(
			async (
				key: string,
				body: unknown,
				opts: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> } = {},
			) => {
				store.set(key, {
					body,
					contentType: opts.httpMetadata?.contentType || '',
					metadata: opts.customMetadata,
				});
				return { key };
			},
		),
		delete: vi.fn(async (key: string) => {
			store.delete(key);
		}),
	};
}

describe('R2MediaStore', () => {
	it('composes key as <scope>/<id> when no fileSuffix given', () => {
		const s = new R2MediaStore({ bucket: fakeBucket() as unknown as R2Bucket, publicHost: 'https://cdn.x' });
		expect(s.buildKey('5511', 'wamid.abc')).toBe('5511/wamid.abc');
		expect(s.buildUrl('5511/wamid.abc')).toBe('https://cdn.x/5511/wamid.abc');
	});

	it('appends fileSuffix when provided', () => {
		const s = new R2MediaStore({ bucket: fakeBucket() as unknown as R2Bucket, publicHost: 'https://cdn.x', fileSuffix: 'photo.jpg' });
		expect(s.buildKey('u', 'id')).toBe('u/id/photo.jpg');
	});

	it('strips trailing slash from publicHost', () => {
		const s = new R2MediaStore({ bucket: fakeBucket() as unknown as R2Bucket, publicHost: 'https://cdn.x/' });
		expect(s.buildUrl('a/b')).toBe('https://cdn.x/a/b');
	});

	it('returns bare key as URL when publicHost is empty', () => {
		const s = new R2MediaStore({ bucket: fakeBucket() as unknown as R2Bucket });
		expect(s.buildUrl('a/b')).toBe('a/b');
	});

	it('sanitizes scope and id — non [A-Za-z0-9._-] becomes _', () => {
		const s = new R2MediaStore({ bucket: fakeBucket() as unknown as R2Bucket });
		expect(s.buildKey('user/with/slashes', 'id with spaces')).toBe('user_with_slashes/id_with_spaces');
	});

	it('upload persists body + contentType + metadata and returns key + url', async () => {
		const bucket = fakeBucket();
		const s = new R2MediaStore({ bucket: bucket as unknown as R2Bucket, publicHost: 'https://cdn.x' });

		const body = new Uint8Array([1, 2, 3]).buffer;
		const r = await s.upload({
			scope: '5511999999999',
			id: 'wamid.abc',
			body,
			contentType: 'image/jpeg',
			metadata: { source: 'inbound' },
		});

		expect(r).toEqual({ key: '5511999999999/wamid.abc', url: 'https://cdn.x/5511999999999/wamid.abc' });
		expect(bucket.put).toHaveBeenCalledWith('5511999999999/wamid.abc', body, {
			httpMetadata: { contentType: 'image/jpeg' },
			customMetadata: { source: 'inbound' },
		});
	});

	it('upload without contentType omits httpMetadata.contentType', async () => {
		const bucket = fakeBucket();
		const s = new R2MediaStore({ bucket: bucket as unknown as R2Bucket, publicHost: 'https://cdn.x' });
		await s.upload({ scope: 'u', id: 'i', body: new ArrayBuffer(1) });
		expect(bucket.put).toHaveBeenCalledWith('u/i', expect.anything(), { httpMetadata: {}, customMetadata: undefined });
	});

	it('delete forwards to bucket.delete', async () => {
		const bucket = fakeBucket();
		const s = new R2MediaStore({ bucket: bucket as unknown as R2Bucket });
		await s.delete('a/b');
		expect(bucket.delete).toHaveBeenCalledWith('a/b');
	});
});
