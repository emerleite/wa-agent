/**
 * Cap-enforced send primitive for opportunistic, user-facing messages
 * (reactive ads, contextual tips, upsell nudges).
 *
 * The bibliafala reactive-ad path looks like:
 *   "After each user reply, maybe send an ad — but at most 2/day, and never
 *    less than 3h after the last one, and never during quiet hours."
 *
 * That's a recurring shape any opportunistic side-channel needs. This class
 * encapsulates it on top of the existing `UsageCounter` (which already tracks
 * per-(whatsapp, feature, used_at) rows), so no new schema is required:
 *
 *   const ads = new RateCappedDispatcher({
 *     counter,
 *     feature: 'reactive_ad',
 *     dailyMax: 2,
 *     minGapSeconds: 3 * 3600,
 *     quietHours: new QuietHours({ start: '22:00', end: '06:00' }),
 *   });
 *
 *   agent.afterReply(async (ctx) => {
 *     await ads.tryDispatch(ctx.user.whatsapp, async () => {
 *       await sendAdViaWhatsApp(ctx.user.whatsapp);
 *       return true;
 *     });
 *   });
 *
 * The `send` callback returns whether it actually delivered. A `false` return
 * (or a throw) means *don't record an impression* — the next call still has
 * the daily allowance free. That avoids the "user got 0 ads but used 2/2"
 * footgun when the upstream send service is down.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { UsageCounter } from '../usage/usage_counter.js';
import { featureUsage } from '../db/schema/usage.js';
import type { QuietHours } from '../util/quiet_hours.js';

export interface RateCappedDispatcherOptions {
	counter: UsageCounter;
	/**
	 * Feature key — partitions the `feature_usage` table. Pick something
	 * unique per channel ('reactive_ad', 'tip', 'upsell_nudge').
	 */
	feature: string;
	/** Maximum impressions per calendar day. */
	dailyMax: number;
	/**
	 * Minimum gap (seconds) between two dispatches to the same user. Set 0
	 * to disable. Defaults to 0.
	 */
	minGapSeconds?: number;
	/** Optional quiet-hours guard. Skips dispatch entirely when inside. */
	quietHours?: QuietHours | null;
}

export type DispatchReason =
	| 'sent'
	| 'quiet_hours'
	| 'min_gap'
	| 'daily_cap'
	| 'send_failed'
	| 'no_whatsapp';

export interface DispatchResult {
	sent: boolean;
	reason: DispatchReason;
}

export type SendFn = () => Promise<boolean | void> | boolean | void;

export class RateCappedDispatcher {
	readonly counter: UsageCounter;
	readonly feature: string;
	readonly dailyMax: number;
	readonly minGapSeconds: number;
	readonly quietHours: QuietHours | null;

	constructor({ counter, feature, dailyMax, minGapSeconds = 0, quietHours = null }: RateCappedDispatcherOptions) {
		if (!counter) throw new Error('RateCappedDispatcher: counter required');
		if (!feature) throw new Error('RateCappedDispatcher: feature required');
		if (!Number.isFinite(dailyMax) || dailyMax < 0) {
			throw new Error('RateCappedDispatcher: dailyMax must be a non-negative number');
		}
		this.counter = counter;
		this.feature = feature;
		this.dailyMax = dailyMax;
		this.minGapSeconds = minGapSeconds;
		this.quietHours = quietHours;
	}

	/**
	 * Check the gap + cap, run `send`, record an impression on success.
	 * Never throws — failures surface in the `reason` field.
	 *
	 * `send` returns truthy to mean "delivered". A void return is treated as
	 * delivered. A thrown error is caught and treated as `send_failed` (no
	 * impression recorded, no propagation to the caller).
	 */
	async tryDispatch(whatsapp: string, send: SendFn, key: string | null = null): Promise<DispatchResult> {
		if (!whatsapp) return { sent: false, reason: 'no_whatsapp' };
		if (this.quietHours && this.quietHours.isQuiet()) {
			return { sent: false, reason: 'quiet_hours' };
		}
		if (this.minGapSeconds > 0) {
			const last = await this.lastDispatchedAt(whatsapp);
			if (last !== null && Date.now() - last < this.minGapSeconds * 1000) {
				return { sent: false, reason: 'min_gap' };
			}
		}
		const dailyCount = await this.counter.getDailyCount(whatsapp, this.feature);
		if (dailyCount >= this.dailyMax) {
			return { sent: false, reason: 'daily_cap' };
		}

		let delivered: boolean;
		try {
			const r = await send();
			delivered = r === undefined ? true : !!r;
		} catch (e) {
			console.error('[RateCappedDispatcher] send threw:', e instanceof Error ? e.message : e);
			return { sent: false, reason: 'send_failed' };
		}

		if (!delivered) return { sent: false, reason: 'send_failed' };

		await this.counter.record(whatsapp, this.feature, key);
		return { sent: true, reason: 'sent' };
	}

	/** ms-since-epoch of the last dispatch for this user, or null. */
	async lastDispatchedAt(whatsapp: string): Promise<number | null> {
		const r = await this.counter.db
			.select({ usedAt: featureUsage.usedAt })
			.from(featureUsage)
			.where(and(eq(featureUsage.whatsapp, whatsapp), eq(featureUsage.feature, this.feature)))
			.orderBy(desc(featureUsage.usedAt))
			.limit(1);
		if (!r.length) return null;
		const raw = r[0]?.usedAt;
		if (!raw) return null;
		// SQLite `datetime('now')` returns "YYYY-MM-DD HH:MM:SS" in UTC with no
		// timezone marker. Date parses such strings as local time; appending 'Z'
		// keeps the comparison against Date.now() honest.
		const ms = Date.parse(raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`);
		return Number.isFinite(ms) ? ms : null;
	}
}

