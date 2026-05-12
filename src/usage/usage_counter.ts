/**
 * Per-user, per-feature usage tracker.
 *
 * Use cases:
 *  - Daily caps ("max 10 image generations per day per user")
 *  - Lifetime caps ("max 100 free AI messages")
 *  - Analytics ("how many users used feature X today?")
 *
 * Different from `AccessGate`: AccessGate decides "tier OR trial" once per
 * conversation; UsageCounter is per-feature event logging that you query
 * before allowing a specific action.
 *
 * From v0.2 onward: backed by Drizzle ORM.
 */
import { and, count, countDistinct, eq, gte, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { featureUsage } from '../db/schema/usage.js';

export interface UsageCounterOptions {
	db: DB;
}

export class UsageCounter {
	readonly db: DB;

	constructor({ db }: UsageCounterOptions) {
		if (!db) throw new Error('UsageCounter: db required');
		this.db = db;
	}

	/**
	 * Record a usage event. `key` is an optional content identifier (e.g. the
	 * verse you generated an image for) — useful for analytics and dedup.
	 */
	async record(whatsapp: string, feature: string, key: string | null = null): Promise<boolean> {
		try {
			await this.db.insert(featureUsage).values({ whatsapp, feature, key });
			return true;
		} catch (e) {
			console.error('[UsageCounter] record:', e instanceof Error ? e.message : e);
			return false;
		}
	}

	async getDailyCount(whatsapp: string, feature: string): Promise<number> {
		const r = await this.db
			.select({ count: count() })
			.from(featureUsage)
			.where(and(eq(featureUsage.whatsapp, whatsapp), eq(featureUsage.feature, feature), eq(sql`date(${featureUsage.usedAt})`, sql`date('now')`)));
		return r[0]?.count ?? 0;
	}

	async getLifetimeCount(whatsapp: string, feature: string): Promise<number> {
		const r = await this.db
			.select({ count: count() })
			.from(featureUsage)
			.where(and(eq(featureUsage.whatsapp, whatsapp), eq(featureUsage.feature, feature)));
		return r[0]?.count ?? 0;
	}

	/**
	 * Atomic check-and-record: if the user is under `dailyMax` for this feature,
	 * record a usage event and return true. Otherwise return false.
	 *
	 * This is best-effort (D1 doesn't support row-level locks); two concurrent
	 * calls could race past the cap by 1. For most chat apps that's acceptable.
	 */
	async tryRecordWithCap(whatsapp: string, feature: string, dailyMax: number, key: string | null = null): Promise<boolean> {
		const c = await this.getDailyCount(whatsapp, feature);
		if (c >= dailyMax) return false;
		return await this.record(whatsapp, feature, key);
	}

	/**
	 * @returns count of distinct users who used `feature` since `sinceHoursAgo` ago (default 24h).
	 */
	async distinctUsersSince(feature: string, { sinceHoursAgo = 24 }: { sinceHoursAgo?: number } = {}): Promise<number> {
		const cutoff = sql.raw(`(datetime('now', '-${sinceHoursAgo} hours'))`);
		const r = await this.db
			.select({ c: countDistinct(featureUsage.whatsapp) })
			.from(featureUsage)
			.where(and(eq(featureUsage.feature, feature), gte(featureUsage.usedAt, cutoff)));
		return r[0]?.c ?? 0;
	}
}
