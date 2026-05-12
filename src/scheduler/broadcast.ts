/**
 * Send the same payload to many users with rate limiting + audit log.
 *
 * From v0.2 onward: backed by Drizzle ORM.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { broadcastLog } from '../db/schema/broadcast.js';
import { messageWindows } from '../db/schema/message_windows.js';
import { leads } from '../db/schema/leads.js';
import type { WhatsAppClient } from '../client/whatsapp.js';
import type { Emit } from '../events/emit.js';

export interface BroadcastOptions {
	client: WhatsAppClient;
	db: DB;
	channel: string;
	sendIntervalMs?: number;
	limit?: number;
	emit?: Emit;
}

export interface BroadcastUser {
	whatsapp: string;
	[k: string]: unknown;
}

export interface BroadcastResult {
	candidates: number;
	delivered: number;
	skipped: number;
}

export interface BroadcastRunArgs {
	send: (user: BroadcastUser) => Promise<boolean>;
	/**
	 * Custom audience generator. When omitted, the default audience is
	 * opt-in users with an open message window who haven't been logged
	 * on `channel` today.
	 */
	audience?: () => Promise<BroadcastUser[]>;
}

export class Broadcast {
	readonly client: WhatsAppClient;
	readonly db: DB;
	readonly channel: string;
	readonly sendIntervalMs: number;
	readonly limit: number;
	readonly emit: Emit | null;

	constructor({ client, db, channel, sendIntervalMs = 1000, limit = 1500, emit = undefined }: BroadcastOptions) {
		if (!client) throw new Error('Broadcast: client required');
		if (!db) throw new Error('Broadcast: db required');
		if (!channel) throw new Error('Broadcast: channel required');
		this.client = client;
		this.db = db;
		this.channel = channel;
		this.sendIntervalMs = sendIntervalMs;
		this.limit = limit;
		this.emit = emit ?? null;
	}

	async defaultAudience(): Promise<BroadcastUser[]> {
		return await this.db
			.select({ whatsapp: messageWindows.whatsapp })
			.from(messageWindows)
			.innerJoin(leads, and(eq(leads.whatsapp, messageWindows.whatsapp), eq(leads.optIn, 1)))
			.leftJoin(
				broadcastLog,
				and(
					eq(broadcastLog.whatsapp, messageWindows.whatsapp),
					eq(broadcastLog.channel, this.channel),
					eq(broadcastLog.date, sql`date('now')`)
				)
			)
			.where(and(sql`datetime('now') < ${messageWindows.endTime}`, isNull(broadcastLog.id)))
			.orderBy(messageWindows.endTime)
			.limit(this.limit);
	}

	async run({ send, audience }: BroadcastRunArgs): Promise<BroadcastResult> {
		if (typeof send !== 'function') throw new Error('Broadcast.run: send() required');

		const users = await (audience ? audience() : this.defaultAudience());

		let delivered = 0;
		let skipped = 0;
		for (const u of users) {
			try {
				const ok = await send(u);
				if (ok) {
					await this.logDelivered(u.whatsapp);
					if (this.emit) await this.emit({ type: 'broadcast_sent', whatsapp: u.whatsapp, channel: this.channel });
					delivered++;
				} else {
					skipped++;
				}
			} catch (e) {
				console.error(`[Broadcast:${this.channel}] ${u.whatsapp}:`, e instanceof Error ? e.message : e);
				skipped++;
			}
			if (this.sendIntervalMs > 0) await sleep(this.sendIntervalMs);
		}
		return { candidates: users.length, delivered, skipped };
	}

	async logDelivered(whatsapp: string): Promise<void> {
		try {
			await this.db
				.insert(broadcastLog)
				.values({ whatsapp, channel: this.channel, date: sql`date('now')` })
				.onConflictDoNothing({ target: [broadcastLog.whatsapp, broadcastLog.channel, broadcastLog.date] });
		} catch (e) {
			console.error(`[Broadcast:${this.channel}] log:`, e instanceof Error ? e.message : e);
		}
	}

	async wasDeliveredToday(whatsapp: string): Promise<boolean> {
		const r = await this.db
			.select({ id: broadcastLog.id })
			.from(broadcastLog)
			.where(and(eq(broadcastLog.whatsapp, whatsapp), eq(broadcastLog.channel, this.channel), eq(broadcastLog.date, sql`date('now')`)))
			.limit(1);
		return r.length > 0;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
