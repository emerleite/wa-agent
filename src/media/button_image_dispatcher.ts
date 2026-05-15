/**
 * Generated-image dispatcher driven by an interactive button tap.
 *
 * Replaces the bibliafala `verse_images/handler.js` shape — parse the button
 * id → check the per-user daily cap → look up R2 (or render-then-upload) →
 * send the image with a caption → record usage — with a renderer-agnostic
 * wrapper. The app supplies:
 *
 *   - `encode` / `decode` — how button args are serialized into the button id
 *   - `cacheKey`           — R2 path computed from args (stable + safe)
 *   - `render`             — the actual image producer (PNG bytes / stream)
 *   - `caption`            — text to caption the sent image
 *
 * Everything else (button-prefix routing, cap enforcement, R2 lookup, send,
 * failure messages, usage recording) is the framework's job.
 *
 * Wiring with the Agent:
 *
 *   const verseImages = new ButtonImageDispatcher({
 *     prefix: 'imggen_',
 *     encode: ({ book, chapter, verse }) => `${book}_${chapter}_${verse}`,
 *     decode: (s) => {
 *       const [book, c, v] = s.split('_');
 *       if (!book || !c || !v) return null;
 *       return { book, chapter: Number(c), verse: Number(v) };
 *     },
 *     cacheKey: ({ book, chapter, verse }) => `verse/${book}-${chapter}-${verse}.png`,
 *     render: async (args) => ({ body: await renderVersePng(args), contentType: 'image/png' }),
 *     caption: ({ book, chapter, verse }) => `📖 ${book} ${chapter}:${verse}`,
 *     cache,
 *     client: agent.client,
 *     usage,
 *     feature: 'verse_image',
 *     dailyMax: 5,
 *   });
 *
 *   agent.buttonPrefix(verseImages.prefix, async ({ user, buttonId }) => {
 *     await verseImages.handle(user.whatsapp, buttonId);
 *   });
 *
 * The dispatcher always responds — successfully with the image, or with a
 * fallback text message — so the user never sees a button that did nothing.
 */
import type { R2Cache, ProducerResult } from './r2_cache.js';
import type { WhatsAppClient } from '../client/whatsapp.js';
import type { UsageCounter } from '../usage/usage_counter.js';

export interface ButtonImageDispatcherOptions<Args> {
	/** Button-id prefix. Must end with the delimiter you separate the suffix on (typically '_'). */
	prefix: string;
	/** Encode args → the suffix portion (the dispatcher prepends `prefix`). */
	encode: (args: Args) => string;
	/** Decode a suffix back to args. Return `null` to mean "malformed". */
	decode: (suffix: string) => Args | null;
	/** R2 path for the rendered output. Stable per-args; used as the cache key. */
	cacheKey: (args: Args) => string;
	/** Produce the image bytes. Called only on cache miss. */
	render: (args: Args) => Promise<ProducerResult>;
	/** Caption text. Sync or async. */
	caption: (args: Args, ctx: { url: string; fromCache: boolean }) => string | Promise<string>;
	cache: R2Cache;
	client: WhatsAppClient;
	/** Optional per-user daily cap, enforced via UsageCounter. */
	usage?: UsageCounter | null;
	/** Required when `usage` is set: the `feature` key in feature_usage. */
	feature?: string;
	/** Required when `usage` is set: the daily allowance. */
	dailyMax?: number;
	/**
	 * Message sent when the user has hit the daily cap. Replaces the default
	 * 'You\'ve hit today\'s limit.' string. Return null/empty to send nothing.
	 */
	capExceededText?: (args: Args) => string | null;
	/**
	 * Message sent when rendering or sending throws. Replaces the default.
	 * Return null/empty to send nothing.
	 */
	errorText?: (args: Args, err: unknown) => string | null;
	/**
	 * Hook fired once an image has been successfully delivered. Fires AFTER
	 * the usage row has been recorded. Failures here are caught + logged.
	 */
	onSuccess?: (args: Args, info: { whatsapp: string; url: string; fromCache: boolean }) => void | Promise<void>;
}

export type DispatchImageReason =
	| 'sent'
	| 'invalid_button'
	| 'daily_cap'
	| 'render_failed'
	| 'send_failed';

export interface DispatchImageResult {
	sent: boolean;
	reason: DispatchImageReason;
	fromCache?: boolean;
	url?: string;
}

export class ButtonImageDispatcher<Args> {
	readonly prefix: string;
	readonly encode: (args: Args) => string;
	readonly decode: (suffix: string) => Args | null;
	readonly cacheKey: (args: Args) => string;
	readonly render: (args: Args) => Promise<ProducerResult>;
	readonly caption: (args: Args, ctx: { url: string; fromCache: boolean }) => string | Promise<string>;
	readonly cache: R2Cache;
	readonly client: WhatsAppClient;
	readonly usage: UsageCounter | null;
	readonly feature: string | null;
	readonly dailyMax: number;
	readonly capExceededText: ((args: Args) => string | null) | null;
	readonly errorText: ((args: Args, err: unknown) => string | null) | null;
	readonly onSuccess: ((args: Args, info: { whatsapp: string; url: string; fromCache: boolean }) => void | Promise<void>) | null;

	constructor(opts: ButtonImageDispatcherOptions<Args>) {
		const {
			prefix,
			encode,
			decode,
			cacheKey,
			render,
			caption,
			cache,
			client,
			usage = null,
			feature,
			dailyMax,
			capExceededText,
			errorText,
			onSuccess,
		} = opts;
		if (!prefix) throw new Error('ButtonImageDispatcher: prefix required');
		if (typeof encode !== 'function' || typeof decode !== 'function') {
			throw new Error('ButtonImageDispatcher: encode + decode required');
		}
		if (typeof cacheKey !== 'function') throw new Error('ButtonImageDispatcher: cacheKey required');
		if (typeof render !== 'function') throw new Error('ButtonImageDispatcher: render required');
		if (typeof caption !== 'function') throw new Error('ButtonImageDispatcher: caption required');
		if (!cache) throw new Error('ButtonImageDispatcher: cache required');
		if (!client) throw new Error('ButtonImageDispatcher: client required');
		if (usage && (!feature || !Number.isFinite(dailyMax))) {
			throw new Error('ButtonImageDispatcher: feature + dailyMax required when usage is set');
		}

		this.prefix = prefix;
		this.encode = encode;
		this.decode = decode;
		this.cacheKey = cacheKey;
		this.render = render;
		this.caption = caption;
		this.cache = cache;
		this.client = client;
		this.usage = usage;
		this.feature = feature ?? null;
		this.dailyMax = dailyMax ?? Infinity;
		this.capExceededText = capExceededText ?? null;
		this.errorText = errorText ?? null;
		this.onSuccess = onSuccess ?? null;
	}

	/** Build the full button id for `args`. Use when wiring the offer button. */
	buttonIdFor(args: Args): string {
		return `${this.prefix}${this.encode(args)}`;
	}

	/** Parse a full button id back to args. Returns null on prefix mismatch or decode failure. */
	parseButtonId(id: string): Args | null {
		if (!id || !id.startsWith(this.prefix)) return null;
		return this.decode(id.slice(this.prefix.length));
	}

	/**
	 * Full dispatch flow. Always responds to the user (success or fallback).
	 * Never throws — failures are caught and surfaced in `reason`.
	 */
	async handle(whatsapp: string, buttonId: string): Promise<DispatchImageResult> {
		const args = this.parseButtonId(buttonId);
		if (args === null) {
			return { sent: false, reason: 'invalid_button' };
		}

		if (this.usage && this.feature) {
			const count = await this.usage.getDailyCount(whatsapp, this.feature);
			if (count >= this.dailyMax) {
				const msg = this.capExceededText ? this.capExceededText(args) : "You've hit today's limit. Try again tomorrow.";
				if (msg) {
					try {
						await this.client.sendText(whatsapp, msg);
					} catch (e) {
						console.error('[ButtonImageDispatcher] cap-exceeded send failed:', e instanceof Error ? e.message : e);
					}
				}
				return { sent: false, reason: 'daily_cap' };
			}
		}

		const key = this.cacheKey(args);
		let url: string;
		let fromCache: boolean;
		try {
			const r = await this.cache.getOrCreate(key, () => this.render(args));
			url = r.url;
			fromCache = r.fromCache;
		} catch (err) {
			console.error('[ButtonImageDispatcher] render/upload failed:', err instanceof Error ? err.message : err);
			const msg = this.errorText
				? this.errorText(args, err)
				: 'Sorry, I could not generate that image. Try again in a moment.';
			if (msg) {
				try {
					await this.client.sendText(whatsapp, msg);
				} catch (sendErr) {
					console.error('[ButtonImageDispatcher] error-text send failed:', sendErr instanceof Error ? sendErr.message : sendErr);
				}
			}
			return { sent: false, reason: 'render_failed' };
		}

		let captionText: string;
		try {
			captionText = await this.caption(args, { url, fromCache });
		} catch (e) {
			console.error('[ButtonImageDispatcher] caption builder threw, falling back to empty:', e instanceof Error ? e.message : e);
			captionText = '';
		}

		try {
			await this.client.sendImageUrl(whatsapp, { url, caption: captionText });
		} catch (err) {
			console.error('[ButtonImageDispatcher] sendImageUrl failed:', err instanceof Error ? err.message : err);
			return { sent: false, reason: 'send_failed', url, fromCache };
		}

		if (this.usage && this.feature) {
			await this.usage.record(whatsapp, this.feature, key);
		}

		if (this.onSuccess) {
			try {
				await this.onSuccess(args, { whatsapp, url, fromCache });
			} catch (e) {
				console.error('[ButtonImageDispatcher] onSuccess threw:', e instanceof Error ? e.message : e);
			}
		}

		return { sent: true, reason: 'sent', url, fromCache };
	}
}
