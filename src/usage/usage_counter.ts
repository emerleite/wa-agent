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
 * Default schema (migration 007_usage.sql):
 *   feature_usage(id, whatsapp, feature, key, used_at)
 */
export interface UsageCounterOptions {
	db: D1Database;
	table?: string;
}

export interface UsageRow {
	id: number;
	whatsapp: string;
	feature: string;
	key: string | null;
	used_at: string;
}

export class UsageCounter {
	readonly db: D1Database;
	readonly table: string;

	constructor({ db, table = 'feature_usage' }: UsageCounterOptions) {
		if (!db) throw new Error('UsageCounter: db required');
		this.db = db;
		this.table = table;
	}

	/**
	 * Record a usage event. `key` is an optional content identifier (e.g. the
	 * verse you generated an image for) — useful for analytics and dedup.
	 */
	async record(whatsapp: string, feature: string, key: string | null = null): Promise<boolean> {
		try {
			await this.db
				.prepare(`INSERT INTO ${this.table} (whatsapp, feature, key) VALUES (?, ?, ?)`)
				.bind(whatsapp, feature, key)
				.run();
			return true;
		} catch (e) {
			console.error('[UsageCounter] record:', e instanceof Error ? e.message : e);
			return false;
		}
	}

	async getDailyCount(whatsapp: string, feature: string): Promise<number> {
		const r = await this.db
			.prepare(
				`SELECT COUNT(*) as count FROM ${this.table}
				 WHERE whatsapp = ? AND feature = ? AND date(used_at) = date('now')`
			)
			.bind(whatsapp, feature)
			.first<{ count: number }>();
		return r?.count ?? 0;
	}

	async getLifetimeCount(whatsapp: string, feature: string): Promise<number> {
		const r = await this.db
			.prepare(`SELECT COUNT(*) as count FROM ${this.table} WHERE whatsapp = ? AND feature = ?`)
			.bind(whatsapp, feature)
			.first<{ count: number }>();
		return r?.count ?? 0;
	}

	/**
	 * Atomic check-and-record: if the user is under `dailyMax` for this feature,
	 * record a usage event and return true. Otherwise return false.
	 *
	 * This is best-effort (D1 doesn't support row-level locks); two concurrent
	 * calls could race past the cap by 1. For most chat apps that's acceptable.
	 */
	async tryRecordWithCap(whatsapp: string, feature: string, dailyMax: number, key: string | null = null): Promise<boolean> {
		const count = await this.getDailyCount(whatsapp, feature);
		if (count >= dailyMax) return false;
		return await this.record(whatsapp, feature, key);
	}

	/**
	 * @returns count of distinct users who used `feature` since `since`.
	 */
	async distinctUsersSince(feature: string, since: string = "datetime('now', '-1 day')"): Promise<number> {
		const r = await this.db
			.prepare(`SELECT COUNT(DISTINCT whatsapp) as c FROM ${this.table} WHERE feature = ? AND used_at >= ${since}`)
			.bind(feature)
			.first<{ c: number }>();
		return r?.c ?? 0;
	}
}
