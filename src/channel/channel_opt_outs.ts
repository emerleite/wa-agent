/**
 * Per-channel opt-out for recurring messages.
 *
 * Different from `LeadStore.optOut()` — that pauses the entire bot.
 * `ChannelOptOuts` lets a user mute *specific* channels (e.g. devotional)
 * while continuing to receive others (e.g. reading plan).
 *
 * Storage shape: one row per (whatsapp, channel). Default is "subscribed"
 * (no row); opting out inserts a row; opting back in deletes it. This
 * avoids per-channel boolean column bloat on the leads table (bibliafala
 * tried that — three columns to start, more queued behind it) and scales
 * to any number of channels without `ALTER TABLE`.
 *
 * Plugs into `Broadcast` audience queries via `notOptedOutSql()`, which
 * returns a `NOT EXISTS (...)` SQL fragment ready to append to the
 * existing WHERE clause.
 */
export interface ChannelOptOutsOptions {
	db: D1Database;
	table?: string;
}

export interface OptOutRow {
	whatsapp: string;
	channel: string;
	opted_out_at: string;
}

export class ChannelOptOuts {
	readonly db: D1Database;
	readonly table: string;

	constructor({ db, table = 'channel_opt_outs' }: ChannelOptOutsOptions) {
		if (!db) throw new Error('ChannelOptOuts: db required');
		this.db = db;
		this.table = table;
	}

	/**
	 * Mute one channel for one user. Idempotent.
	 */
	async optOut(whatsapp: string, channel: string): Promise<void> {
		await this.db
			.prepare(
				`INSERT INTO ${this.table} (whatsapp, channel) VALUES (?, ?)
				 ON CONFLICT(whatsapp, channel) DO NOTHING`
			)
			.bind(whatsapp, channel)
			.run();
	}

	/**
	 * Re-subscribe to one channel. Idempotent (DELETE matches 0 or 1 row).
	 */
	async optIn(whatsapp: string, channel: string): Promise<void> {
		await this.db
			.prepare(`DELETE FROM ${this.table} WHERE whatsapp = ? AND channel = ?`)
			.bind(whatsapp, channel)
			.run();
	}

	async isOptedOut(whatsapp: string, channel: string): Promise<boolean> {
		const row = await this.db
			.prepare(`SELECT 1 FROM ${this.table} WHERE whatsapp = ? AND channel = ? LIMIT 1`)
			.bind(whatsapp, channel)
			.first();
		return row != null;
	}

	/**
	 * @returns the set of channels this user has muted.
	 */
	async listOptOuts(whatsapp: string): Promise<string[]> {
		const r = await this.db
			.prepare(`SELECT channel FROM ${this.table} WHERE whatsapp = ?`)
			.bind(whatsapp)
			.all<{ channel: string }>();
		return (r.results ?? []).map((x) => x.channel);
	}

	/**
	 * Mass-mute: returns whatsapp numbers currently opted out of `channel`.
	 */
	async listOptedOutFor(channel: string, { limit = 5000 }: { limit?: number } = {}): Promise<string[]> {
		const r = await this.db
			.prepare(`SELECT whatsapp FROM ${this.table} WHERE channel = ? LIMIT ?`)
			.bind(channel, limit)
			.all<{ whatsapp: string }>();
		return (r.results ?? []).map((x) => x.whatsapp);
	}

	/**
	 * SQL fragment for audience queries.
	 *
	 *   const q = `
	 *     SELECT mw.whatsapp FROM message_windows mw
	 *     JOIN leads l ON l.whatsapp = mw.whatsapp AND l.opt_in = 1
	 *     WHERE datetime('now') < mw.end_time
	 *       AND ${channels.notOptedOutSql('devotional', 'mw.whatsapp')}
	 *   `
	 *
	 * The fragment uses NOT EXISTS rather than a LEFT JOIN so it composes
	 * cleanly inside any WHERE clause without disturbing the row count
	 * upstream (e.g. when combined with broadcast_log dedupe joins).
	 *
	 * @param channel  channel name to check (parameterized by the caller)
	 * @param userSqlExpr   SQL expression that yields the whatsapp number in
	 *                      the outer query — default 'whatsapp'. Pass the
	 *                      qualified alias (`mw.whatsapp`) when joining.
	 */
	notOptedOutSql(channel: string, userSqlExpr: string = 'whatsapp'): string {
		// channel is interpolated literally — callers always pass a constant string,
		// not user input. The whatsapp number stays parameterized via userSqlExpr.
		const escaped = channel.replace(/'/g, "''");
		return `NOT EXISTS (SELECT 1 FROM ${this.table} co WHERE co.whatsapp = ${userSqlExpr} AND co.channel = '${escaped}')`;
	}
}
