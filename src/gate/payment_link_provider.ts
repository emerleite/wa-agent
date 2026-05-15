/**
 * Pluggable per-user payment-link lookup.
 *
 * Parallel to `TierProvider`: where `TierProvider.getTier` answers "is this
 * user paid?", `PaymentLinkProvider.getPaymentLink` answers "where do I send
 * a free-tier user to upgrade?". Returns null when no link is available
 * (provider down, user ineligible, free product, etc.) — callers must handle
 * null gracefully.
 *
 * Wires into `expandTokens` so an outbound message body can carry a
 * `{{subscription_link}}` placeholder that's resolved at send time:
 *
 *   const body = await expandTokens(template, {
 *     '{{subscription_link}}': () => paymentLinks.getPaymentLink(whatsapp),
 *   });
 */

export interface PaymentLinkContext {
	whatsapp: string;
	name?: string | null;
	/** Optional campaign/source so the gateway can attribute the click. */
	campaign?: string | null;
}

export abstract class PaymentLinkProvider {
	abstract getPaymentLink(ctx: PaymentLinkContext): Promise<string | null>;
}

export interface HttpPaymentLinkProviderOptions {
	baseUrl: string;
	token?: string;
	/** Override URL construction. Default: `${baseUrl}/${whatsapp}/payment_link`. */
	urlFor?: (whatsapp: string) => string;
	/** Cache successful lookups for this many ms. 0 disables. Default 60_000. */
	cacheMs?: number;
	/** Pull the link out of the JSON response. Default: `(d) => d.payment_link`. */
	extract?: (data: unknown) => string | null;
}

interface CacheEntry {
	t: number;
	v: string | null;
}

export class HttpPaymentLinkProvider extends PaymentLinkProvider {
	readonly baseUrl: string;
	readonly token: string | undefined;
	readonly urlFor: (whatsapp: string) => string;
	readonly cacheMs: number;
	readonly extract: (data: unknown) => string | null;
	readonly cache = new Map<string, CacheEntry>();

	constructor({ baseUrl, token, urlFor, cacheMs = 60_000, extract }: HttpPaymentLinkProviderOptions) {
		super();
		if (!baseUrl) throw new Error('HttpPaymentLinkProvider: baseUrl required');
		this.baseUrl = baseUrl.replace(/\/$/, '');
		this.token = token;
		this.urlFor = urlFor || ((wa) => `${this.baseUrl}/${wa}/payment_link`);
		this.cacheMs = cacheMs;
		this.extract =
			extract ||
			((d) => {
				if (d && typeof d === 'object' && 'payment_link' in d) {
					const v = (d as { payment_link?: unknown }).payment_link;
					return typeof v === 'string' ? v : null;
				}
				return null;
			});
	}

	async getPaymentLink(ctx: PaymentLinkContext): Promise<string | null> {
		const { whatsapp, name = '', campaign = null } = ctx;
		const cached = this.cache.get(whatsapp);
		if (cached && Date.now() - cached.t < this.cacheMs) return cached.v;

		try {
			const headers: Record<string, string> = {
				accept: 'application/json',
				'content-type': 'application/json',
			};
			if (this.token) headers.Authorization = `Bearer ${this.token}`;
			const body = JSON.stringify({ name: name ?? '', campaign });
			const r = await fetch(this.urlFor(whatsapp), { method: 'POST', headers, body });
			if (r.status !== 200) {
				this.cache.set(whatsapp, { t: Date.now(), v: null });
				return null;
			}
			const data = (await r.json()) as unknown;
			const link = this.extract(data);
			this.cache.set(whatsapp, { t: Date.now(), v: link });
			return link;
		} catch (e) {
			console.error('[HttpPaymentLinkProvider]', e instanceof Error ? e.message : e);
			return null;
		}
	}

	invalidate(whatsapp: string): void {
		this.cache.delete(whatsapp);
	}
}

/**
 * Async token-expansion utility. Resolves any token whose value is a function
 * — lazy, so providers that throw or 404 only run when the placeholder is
 * actually present in `text`.
 *
 * Tokens whose resolver returns null leave the placeholder intact, so the
 * caller can detect a failed expansion and react (drop the message, fall
 * back to a static URL, etc.).
 */
export type TokenResolver = string | null | (() => Promise<string | null> | string | null);

export async function expandTokens(text: string, tokens: Record<string, TokenResolver>): Promise<string> {
	let out = text;
	for (const [token, resolver] of Object.entries(tokens)) {
		if (!out.includes(token)) continue;
		const value = typeof resolver === 'function' ? await resolver() : resolver;
		if (value == null) continue;
		out = out.split(token).join(value);
	}
	return out;
}
