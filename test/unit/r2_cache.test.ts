import { describe, it, expect, vi } from 'vitest';
import { R2Cache } from '../../src/media/r2_cache.js';

function fakeBucket() {
	const store = new Map<string, { body: unknown; contentType: string }>();
	return {
		store,
		head: vi.fn(async (key: string) => (store.has(key) ? { key, size: 1 } : null)),
		put: vi.fn(async (key: string, body: unknown, opts: { httpMetadata?: { contentType?: string } } = {}) => {
			store.set(key, { body, contentType: opts.httpMetadata?.contentType || '' });
			return { key };
		}),
	};
}

describe('R2Cache', () => {
	it('throws on missing bucket or publicHost', () => {
		// @ts-expect-error testing error path
		expect(() => new R2Cache({})).toThrow();
		// @ts-expect-error testing error path
		expect(() => new R2Cache({ bucket: {}, publicHost: '' })).toThrow();
	});

	it('strips trailing slash from publicHost', () => {
		const c = new R2Cache({ bucket: fakeBucket() as unknown as R2Bucket, publicHost: 'https://x.com/' });
		expect(c.urlFor('a/b.mp3')).toBe('https://x.com/a/b.mp3');
	});

	it('getOrCreate calls producer and uploads on cache miss', async () => {
		const bucket = fakeBucket();
		const c = new R2Cache({ bucket: bucket as unknown as R2Bucket, publicHost: 'https://m.x' });
		const producer = vi.fn(async () => ({ body: 'hello', contentType: 'audio/mpeg' }));

		const r = await c.getOrCreate('tts/1.mp3', producer);
		expect(r).toEqual({ url: 'https://m.x/tts/1.mp3', fromCache: false });
		expect(producer).toHaveBeenCalledOnce();
		expect(bucket.put).toHaveBeenCalledWith('tts/1.mp3', 'hello', { httpMetadata: { contentType: 'audio/mpeg' } });
	});

	it('getOrCreate skips producer on cache hit', async () => {
		const bucket = fakeBucket();
		bucket.store.set('cached', { body: 'old', contentType: 'audio/mpeg' });

		const c = new R2Cache({ bucket: bucket as unknown as R2Bucket, publicHost: 'https://m.x' });
		const producer = vi.fn();

		const r = await c.getOrCreate('cached', producer);
		expect(r).toEqual({ url: 'https://m.x/cached', fromCache: true });
		expect(producer).not.toHaveBeenCalled();
	});
});
