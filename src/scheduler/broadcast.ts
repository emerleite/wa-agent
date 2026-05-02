/**
 * Send the same payload to many users with rate limiting + audit log.
 */
import type { WhatsAppClient } from '../client/whatsapp.js';

export interface BroadcastOptions {
	client: WhatsAppClient;
	db: D1Database;
	channel: string;
	logTable?: string;
	sendIntervalMs?: number;
	limit?: number;
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
	audienceQuery?: string;
	audienceBindings?: unknown[];
}

export class Broadcast {
	readonly client: WhatsAppClient;
	readonly db: D1Database;
	readonly channel: string;
	readonly logTable: string;
	readonly sendIntervalMs: number;
	readonly limit: number;

	constructor({ client, db, channel, logTable = 'broadcast_log', sendIntervalMs = 1000, limit = 1500 }: BroadcastOptions) {
		if (!client) throw new Error('Broadcast: client required');
		if (!db) throw new Error('Broadcast: db required');
		if (!channel) throw new Error('Broadcast: channel required');
		this.client = client;
		this.db = db;
		this.channel = channel;
		this.logTable = logTable;
		this.sendIntervalMs = sendIntervalMs;
		this.limit = limit;
	}

	defaultAudienceQuery(): string {
		return `
			SELECT mw.whatsapp
			FROM message_windows mw
			INNER JOIN leads l ON l.whatsapp = mw.whatsapp AND l.opt_in = 1
			LEFT JOIN ${this.logTable} bl
				ON bl.whatsapp = mw.whatsapp AND bl.channel = ? AND bl.date = date('now')
			WHERE datetime('now') < mw.end_time
			  AND bl.id IS NULL
			ORDER BY mw.end_time
			LIMIT ?`;
	}

	async run({ send, audienceQuery, audienceBindings }: BroadcastRunArgs): Promise<BroadcastResult> {
		if (typeof send !== 'function') throw new Error('Broadcast.run: send() required');

		const sql = audienceQuery || this.defaultAudienceQuery();
		const bindings = audienceBindings || [this.channel, this.limit];

		const r = await this.db.prepare(sql).bind(...bindings).all<BroadcastUser>();
		const users = r.results ?? [];

		let delivered = 0;
		let skipped = 0;
		for (const u of users) {
			try {
				const ok = await send(u);
				if (ok) {
					await this.logDelivered(u.whatsapp);
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
				.prepare(`INSERT OR IGNORE INTO ${this.logTable} (whatsapp, channel, date) VALUES (?, ?, date('now'))`)
				.bind(whatsapp, this.channel)
				.run();
		} catch (e) {
			console.error(`[Broadcast:${this.channel}] log:`, e instanceof Error ? e.message : e);
		}
	}

	async wasDeliveredToday(whatsapp: string): Promise<boolean> {
		const row = await this.db
			.prepare(`SELECT 1 FROM ${this.logTable} WHERE whatsapp = ? AND channel = ? AND date = date('now') LIMIT 1`)
			.bind(whatsapp, this.channel)
			.first();
		return !!row;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
