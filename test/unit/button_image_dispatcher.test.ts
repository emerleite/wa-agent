import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ButtonImageDispatcher } from '../../src/media/button_image_dispatcher.js';
import { R2Cache } from '../../src/media/r2_cache.js';
import type { WhatsAppClient } from '../../src/client/whatsapp.js';
import type { UsageCounter } from '../../src/usage/usage_counter.js';

interface VerseArgs {
	book: string;
	chapter: number;
	verse: number;
}

function fakeBucket(initial: Record<string, { body: unknown; contentType: string }> = {}) {
	const store = new Map(Object.entries(initial));
	return {
		store,
		head: vi.fn(async (key: string) => (store.has(key) ? { key, size: 1 } : null)),
		put: vi.fn(async (key: string, body: unknown, opts: { httpMetadata?: { contentType?: string } } = {}) => {
			store.set(key, { body, contentType: opts.httpMetadata?.contentType || '' });
			return { key };
		}),
	};
}

function fakeClient() {
	return {
		sendText: vi.fn(async () => true),
		sendImageUrl: vi.fn(async () => true),
	} as unknown as WhatsAppClient & { sendText: ReturnType<typeof vi.fn>; sendImageUrl: ReturnType<typeof vi.fn> };
}

function fakeUsage(initialDaily = 0) {
	let recorded = initialDaily;
	const records: Array<{ whatsapp: string; feature: string; key: string | null }> = [];
	return {
		getDailyCount: vi.fn(async () => recorded),
		record: vi.fn(async (whatsapp: string, feature: string, key: string | null) => {
			records.push({ whatsapp, feature, key });
			recorded += 1;
			return true;
		}),
		_records: records,
		_set(n: number) {
			recorded = n;
		},
	} as unknown as UsageCounter & {
		getDailyCount: ReturnType<typeof vi.fn>;
		record: ReturnType<typeof vi.fn>;
		_records: Array<{ whatsapp: string; feature: string; key: string | null }>;
		_set(n: number): void;
	};
}

function makeDispatcher(overrides: Partial<ConstructorParameters<typeof ButtonImageDispatcher<VerseArgs>>[0]> = {}) {
	const bucket = fakeBucket();
	const cache = new R2Cache({ bucket: bucket as unknown as R2Bucket, publicHost: 'https://m.x' });
	const client = fakeClient();
	const render = vi.fn(async () => ({ body: 'png-bytes', contentType: 'image/png' }));
	const dispatcher = new ButtonImageDispatcher<VerseArgs>({
		prefix: 'img_',
		encode: ({ book, chapter, verse }) => `${book}_${chapter}_${verse}`,
		decode: (s) => {
			const [book, c, v] = s.split('_');
			if (!book || !c || !v) return null;
			const chapter = Number(c);
			const verse = Number(v);
			if (!Number.isFinite(chapter) || !Number.isFinite(verse)) return null;
			return { book, chapter, verse };
		},
		cacheKey: ({ book, chapter, verse }) => `verse/${book}-${chapter}-${verse}.png`,
		render,
		caption: ({ book, chapter, verse }) => `📖 ${book} ${chapter}:${verse}`,
		cache,
		client,
		...overrides,
	});
	return { dispatcher, bucket, client, cache, render };
}

describe('ButtonImageDispatcher — config', () => {
	it('throws on missing required deps', () => {
		// @ts-expect-error testing
		expect(() => new ButtonImageDispatcher({})).toThrow();
		expect(() =>
			new ButtonImageDispatcher<VerseArgs>({
				prefix: 'img_',
				// @ts-expect-error testing
				encode: undefined,
				decode: () => null,
				cacheKey: () => '',
				render: async () => ({ body: '', contentType: 'image/png' }),
				caption: () => '',
				cache: {} as R2Cache,
				client: {} as WhatsAppClient,
			})
		).toThrow();
	});

	it('throws when usage is set without feature/dailyMax', () => {
		expect(() =>
			new ButtonImageDispatcher<VerseArgs>({
				prefix: 'img_',
				encode: () => 'x',
				decode: () => null,
				cacheKey: () => 'k',
				render: async () => ({ body: '', contentType: 'image/png' }),
				caption: () => '',
				cache: {} as R2Cache,
				client: {} as WhatsAppClient,
				usage: {} as UsageCounter,
			})
		).toThrow();
	});
});

describe('ButtonImageDispatcher — id encoding', () => {
	it('buttonIdFor + parseButtonId round trip', () => {
		const { dispatcher } = makeDispatcher();
		const id = dispatcher.buttonIdFor({ book: 'jo', chapter: 3, verse: 16 });
		expect(id).toBe('img_jo_3_16');
		expect(dispatcher.parseButtonId(id)).toEqual({ book: 'jo', chapter: 3, verse: 16 });
	});

	it('parseButtonId returns null on prefix mismatch', () => {
		const { dispatcher } = makeDispatcher();
		expect(dispatcher.parseButtonId('other_jo_3_16')).toBeNull();
	});

	it('parseButtonId returns null when decoder returns null', () => {
		const { dispatcher } = makeDispatcher();
		expect(dispatcher.parseButtonId('img_bad')).toBeNull();
	});
});

describe('ButtonImageDispatcher — happy path', () => {
	let f: ReturnType<typeof makeDispatcher>;
	beforeEach(() => {
		f = makeDispatcher();
	});

	it('renders, uploads, sends image with caption, returns sent', async () => {
		const r = await f.dispatcher.handle('5551', 'img_jo_3_16');
		expect(r).toEqual({ sent: true, reason: 'sent', url: 'https://m.x/verse/jo-3-16.png', fromCache: false });
		expect(f.render).toHaveBeenCalledOnce();
		expect(f.bucket.put).toHaveBeenCalledOnce();
		expect((f.client as unknown as { sendImageUrl: ReturnType<typeof vi.fn> }).sendImageUrl).toHaveBeenCalledWith('5551', {
			url: 'https://m.x/verse/jo-3-16.png',
			caption: '📖 jo 3:16',
		});
	});

	it('skips render on cache hit and reports fromCache=true', async () => {
		const bucket = fakeBucket({ 'verse/jo-3-16.png': { body: 'old', contentType: 'image/png' } });
		const cache = new R2Cache({ bucket: bucket as unknown as R2Bucket, publicHost: 'https://m.x' });
		const f2 = makeDispatcher({ cache });
		const r = await f2.dispatcher.handle('5551', 'img_jo_3_16');
		expect(r.sent).toBe(true);
		expect(r.fromCache).toBe(true);
		expect(f2.render).not.toHaveBeenCalled();
	});

	it('caption can be async', async () => {
		const f2 = makeDispatcher({ caption: async ({ book }) => `async ${book}` });
		await f2.dispatcher.handle('5551', 'img_jo_3_16');
		const sendImage = (f2.client as unknown as { sendImageUrl: ReturnType<typeof vi.fn> }).sendImageUrl;
		expect(sendImage.mock.calls[0]?.[1]?.caption).toBe('async jo');
	});

	it('fires onSuccess after recording usage', async () => {
		const onSuccess = vi.fn();
		const usage = fakeUsage();
		const f2 = makeDispatcher({ usage, feature: 'img', dailyMax: 5, onSuccess });
		await f2.dispatcher.handle('5551', 'img_jo_3_16');
		expect(usage.record).toHaveBeenCalledOnce();
		expect(onSuccess).toHaveBeenCalledWith({ book: 'jo', chapter: 3, verse: 16 }, expect.objectContaining({ whatsapp: '5551', fromCache: false }));
	});
});

describe('ButtonImageDispatcher — invalid button', () => {
	it('returns invalid_button without sending', async () => {
		const f = makeDispatcher();
		const r = await f.dispatcher.handle('5551', 'totally_wrong');
		expect(r).toEqual({ sent: false, reason: 'invalid_button' });
		expect((f.client as unknown as { sendImageUrl: ReturnType<typeof vi.fn> }).sendImageUrl).not.toHaveBeenCalled();
		expect((f.client as unknown as { sendText: ReturnType<typeof vi.fn> }).sendText).not.toHaveBeenCalled();
	});

	it('returns invalid_button when decode returns null', async () => {
		const f = makeDispatcher();
		const r = await f.dispatcher.handle('5551', 'img_bad');
		expect(r).toEqual({ sent: false, reason: 'invalid_button' });
	});
});

describe('ButtonImageDispatcher — daily cap', () => {
	it('blocks when at/above the cap and sends fallback text', async () => {
		const usage = fakeUsage(5);
		const f = makeDispatcher({ usage, feature: 'img', dailyMax: 5 });
		const r = await f.dispatcher.handle('5551', 'img_jo_3_16');
		expect(r).toEqual({ sent: false, reason: 'daily_cap' });
		expect(f.render).not.toHaveBeenCalled();
		expect((f.client as unknown as { sendText: ReturnType<typeof vi.fn> }).sendText).toHaveBeenCalledWith('5551', expect.stringContaining("limit"));
	});

	it('honors custom capExceededText', async () => {
		const usage = fakeUsage(5);
		const f = makeDispatcher({ usage, feature: 'img', dailyMax: 5, capExceededText: () => 'cap reached friend' });
		await f.dispatcher.handle('5551', 'img_jo_3_16');
		expect((f.client as unknown as { sendText: ReturnType<typeof vi.fn> }).sendText).toHaveBeenCalledWith('5551', 'cap reached friend');
	});

	it('omits cap text when capExceededText returns null', async () => {
		const usage = fakeUsage(5);
		const f = makeDispatcher({ usage, feature: 'img', dailyMax: 5, capExceededText: () => null });
		await f.dispatcher.handle('5551', 'img_jo_3_16');
		expect((f.client as unknown as { sendText: ReturnType<typeof vi.fn> }).sendText).not.toHaveBeenCalled();
	});

	it('does not record usage when capped', async () => {
		const usage = fakeUsage(5);
		const f = makeDispatcher({ usage, feature: 'img', dailyMax: 5 });
		await f.dispatcher.handle('5551', 'img_jo_3_16');
		expect(usage.record).not.toHaveBeenCalled();
	});
});

describe('ButtonImageDispatcher — failures', () => {
	it('render throw → render_failed + fallback text', async () => {
		const render = vi.fn(async () => {
			throw new Error('resvg blew up');
		});
		const f = makeDispatcher({ render });
		const r = await f.dispatcher.handle('5551', 'img_jo_3_16');
		expect(r).toEqual({ sent: false, reason: 'render_failed' });
		expect((f.client as unknown as { sendImageUrl: ReturnType<typeof vi.fn> }).sendImageUrl).not.toHaveBeenCalled();
		expect((f.client as unknown as { sendText: ReturnType<typeof vi.fn> }).sendText).toHaveBeenCalledOnce();
	});

	it('sendImageUrl throw → send_failed; usage NOT recorded', async () => {
		const client = fakeClient();
		(client as unknown as { sendImageUrl: ReturnType<typeof vi.fn> }).sendImageUrl.mockRejectedValueOnce(new Error('meta down'));
		const usage = fakeUsage();
		const f = makeDispatcher({ client, usage, feature: 'img', dailyMax: 5 });
		const r = await f.dispatcher.handle('5551', 'img_jo_3_16');
		expect(r.sent).toBe(false);
		expect(r.reason).toBe('send_failed');
		expect(usage.record).not.toHaveBeenCalled();
	});

	it('onSuccess throw does NOT flip result to failure', async () => {
		const onSuccess = vi.fn(() => {
			throw new Error('hook crashed');
		});
		const f = makeDispatcher({ onSuccess });
		const r = await f.dispatcher.handle('5551', 'img_jo_3_16');
		expect(r.sent).toBe(true);
	});
});
