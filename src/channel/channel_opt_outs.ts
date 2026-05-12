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
 * Plugs into `Broadcast` audience queries via `notOptedOut()`, which
 * returns a Drizzle `SQL` fragment ready to drop into a `.where(and(...))`.
 *
 * From v0.2 onward: backed by Drizzle ORM.
 */
import { and, eq, notExists, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { channelOptOuts } from '../db/schema/channel_opt_outs.js';

export interface ChannelOptOutsOptions {
	db: DB;
}

export class ChannelOptOuts {
	readonly db: DB;

	constructor({ db }: ChannelOptOutsOptions) {
		if (!db) throw new Error('ChannelOptOuts: db required');
		this.db = db;
	}

	/**
	 * Mute one channel for one user. Idempotent.
	 */
	async optOut(whatsapp: string, channel: string): Promise<void> {
		await this.db
			.insert(channelOptOuts)
			.values({ whatsapp, channel })
			.onConflictDoNothing({ target: [channelOptOuts.whatsapp, channelOptOuts.channel] });
	}

	/**
	 * Re-subscribe to one channel. Idempotent (DELETE matches 0 or 1 row).
	 */
	async optIn(whatsapp: string, channel: string): Promise<void> {
		await this.db.delete(channelOptOuts).where(and(eq(channelOptOuts.whatsapp, whatsapp), eq(channelOptOuts.channel, channel)));
	}

	async isOptedOut(whatsapp: string, channel: string): Promise<boolean> {
		const r = await this.db
			.select({ one: sql`1` })
			.from(channelOptOuts)
			.where(and(eq(channelOptOuts.whatsapp, whatsapp), eq(channelOptOuts.channel, channel)))
			.limit(1);
		return r.length > 0;
	}

	/**
	 * @returns the set of channels this user has muted.
	 */
	async listOptOuts(whatsapp: string): Promise<string[]> {
		const rows = await this.db.select({ channel: channelOptOuts.channel }).from(channelOptOuts).where(eq(channelOptOuts.whatsapp, whatsapp));
		return rows.map((r) => r.channel);
	}

	/**
	 * Mass-mute: returns whatsapp numbers currently opted out of `channel`.
	 */
	async listOptedOutFor(channel: string, { limit = 5000 }: { limit?: number } = {}): Promise<string[]> {
		const rows = await this.db
			.select({ whatsapp: channelOptOuts.whatsapp })
			.from(channelOptOuts)
			.where(eq(channelOptOuts.channel, channel))
			.limit(limit);
		return rows.map((r) => r.whatsapp);
	}

	/**
	 * Drizzle `SQL` fragment for audience queries.
	 *
	 *   .where(and(
	 *     ...,
	 *     channels.notOptedOut('devotional', messageWindows.whatsapp)
	 *   ))
	 *
	 * Uses NOT EXISTS so it composes inside any WHERE clause without
	 * disturbing the row count upstream.
	 *
	 * @param channel  channel name to check (parameterized, safe from injection)
	 * @param userColumn   Drizzle column reference to the whatsapp number in
	 *                     the outer query (e.g. `messageWindows.whatsapp`).
	 */
	notOptedOut(channel: string, userColumn: SQLWrapper): SQL {
		return notExists(
			this.db
				.select({ one: sql`1` })
				.from(channelOptOuts)
				.where(and(eq(channelOptOuts.whatsapp, userColumn), eq(channelOptOuts.channel, channel)))
		);
	}
}
