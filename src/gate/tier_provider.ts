/**
 * Pluggable subscription/tier lookup.
 */
import type { Tier, TierResult } from '../types.js';

export abstract class TierProvider {
	abstract getTier(whatsapp: string): Promise<TierResult>;
}

export interface HttpTierProviderOptions {
	baseUrl: string;
	token?: string;
	urlFor?: (whatsapp: string) => string;
	cacheMs?: number;
	defaultTier?: Tier;
}

export class HttpTierProvider extends TierProvider {
	readonly baseUrl: string;
	readonly token: string | undefined;
	readonly urlFor: (whatsapp: string) => string;
	readonly cacheMs: number;
	readonly defaultTier: Tier;
	readonly cache = new Map<string, { t: number; v: TierResult }>();

	constructor({ baseUrl, token, urlFor, cacheMs = 60_000, defaultTier = 'free' }: HttpTierProviderOptions) {
		super();
		if (!baseUrl) throw new Error('HttpTierProvider: baseUrl required');
		this.baseUrl = baseUrl.replace(/\/$/, '');
		this.token = token;
		this.urlFor = urlFor || ((wa) => `${this.baseUrl}/${wa}/tier`);
		this.cacheMs = cacheMs;
		this.defaultTier = defaultTier;
	}

	async getTier(whatsapp: string): Promise<TierResult> {
		const cached = this.cache.get(whatsapp);
		if (cached && Date.now() - cached.t < this.cacheMs) return cached.v;

		try {
			const headers: Record<string, string> = { accept: 'application/json' };
			if (this.token) headers.Authorization = `Bearer ${this.token}`;
			const r = await fetch(this.urlFor(whatsapp), { method: 'GET', headers });
			if (r.status !== 200) {
				const fallback: TierResult = { authorized: false, tier: this.defaultTier };
				this.cache.set(whatsapp, { t: Date.now(), v: fallback });
				return fallback;
			}
			const d = (await r.json()) as { authorized?: boolean; tier?: string };
			const value: TierResult = { authorized: !!d.authorized, tier: (d.tier as Tier) || this.defaultTier };
			this.cache.set(whatsapp, { t: Date.now(), v: value });
			return value;
		} catch (e) {
			console.error('[HttpTierProvider]', e instanceof Error ? e.message : e);
			return { authorized: false, tier: this.defaultTier };
		}
	}

	invalidate(whatsapp: string): void {
		this.cache.delete(whatsapp);
	}
}

export class StaticTierProvider extends TierProvider {
	constructor(private readonly map: Record<string, TierResult> = {}) {
		super();
	}
	async getTier(whatsapp: string): Promise<TierResult> {
		return this.map[whatsapp] || { authorized: false, tier: 'free' };
	}
}
