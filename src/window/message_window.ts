/**
 * Tracks Meta's customer service window so the agent knows when it can send
 * a free-form (non-template) message.
 *
 * From v0.2 onward: backed by Drizzle ORM.
 */
import { eq, gt, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { messageWindows } from '../db/schema/message_windows.js';

export type WindowType = 'free' | 'paid';

export interface MessageWindowOptions {
	db: DB;
	freeWindowExpr?: string;
	paidWindowExpr?: string;
}

export interface WindowStatus {
	inWindow: boolean;
	type: WindowType | null;
}

export interface OpenWindowRow {
	whatsapp: string;
	window_type: WindowType;
	end_time: string;
}

export class MessageWindow {
	readonly db: DB;
	readonly freeWindowExpr: string;
	readonly paidWindowExpr: string;

	constructor({
		db,
		freeWindowExpr = "datetime('now', '+71 hours', '+30 minutes')",
		paidWindowExpr = "datetime('now', '+23 hours', '+30 minutes')",
	}: MessageWindowOptions) {
		if (!db) throw new Error('MessageWindow: db required');
		this.db = db;
		this.freeWindowExpr = freeWindowExpr;
		this.paidWindowExpr = paidWindowExpr;
	}

	async start(whatsapp: string, type: WindowType = 'paid'): Promise<void> {
		const expr = type === 'free' ? this.freeWindowExpr : this.paidWindowExpr;
		await this.db
			.insert(messageWindows)
			.values({ whatsapp, windowType: type, endTime: sql.raw(`(${expr})`) })
			.onConflictDoUpdate({
				target: messageWindows.whatsapp,
				set: {
					windowType: type,
					startTime: sql`(datetime('now'))`,
					endTime: sql.raw(`(${expr})`),
				},
			});
	}

	async status(whatsapp: string): Promise<WindowStatus> {
		const r = await this.db
			.select({
				windowType: messageWindows.windowType,
				within: sql<number>`(datetime('now') < ${messageWindows.endTime})`.as('within'),
			})
			.from(messageWindows)
			.where(eq(messageWindows.whatsapp, whatsapp))
			.limit(1);
		const row = r[0];
		if (!row) return { inWindow: false, type: null };
		return { inWindow: !!row.within, type: row.windowType };
	}

	async listOpen({ limit = 5000 }: { limit?: number } = {}): Promise<OpenWindowRow[]> {
		const r = await this.db
			.select({
				whatsapp: messageWindows.whatsapp,
				window_type: messageWindows.windowType,
				end_time: messageWindows.endTime,
			})
			.from(messageWindows)
			.where(gt(messageWindows.endTime, sql`(datetime('now'))`))
			.limit(limit);
		return r as OpenWindowRow[];
	}
}
